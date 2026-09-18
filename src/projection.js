import { openDisputeStates } from './domain.js';
import { NotFoundError } from './errors.js';

/**
 * 把事件日志重放成可供查询与决策校验的读模型。
 * 投影只随事件增长而变化：撤回只置标记、发布只改状态，任何事实都不会被删除。
 */
export class Projection {
  constructor(events = []) {
    // 用户与学校
    this.users = new Map();          // userId -> { userId, displayName, schoolId, role }
    this.schools = new Map();        // schoolId -> { schoolId, name }

    // 资源与版本
    this.resources = new Map();      // resourceId -> resource 读模型
    this.versions = new Map();       // versionId -> version 读模型
    this.versionByResource = new Map(); // resourceId -> [versionId]（按建立顺序）

    // 贡献（含已撤回）
    this.contributions = new Map();   // contributionId -> contribution 读模型
    this.contributionsByVersion = new Map();

    // 立场确认：一位教师对一个版本只有一条当前立场，重复确认仅累加计数
    this.confirmationByTeacher = new Map(); // `${versionId}|${teacherRef}` -> confirmation

    // 异议
    this.disputes = new Map();
    this.disputesByVersion = new Map();

    // 署名顺序裁定轨迹（每次裁定都留痕，同一教师以最后一次为准）
    this.orderingByVersion = new Map();

    // 授权与发布
    this.authorizationByVersion = new Map();
    this.publicationByVersion = new Map();
    this.publicationCounter = 0;

    // 参与者：在版本上申报过贡献或提出过异议的教师
    this.participantKeys = new Set();

    for (const event of events) this.apply(event);
  }

  // ---- 基础查询 ----

  getUser(userId) {
    return this.users.get(userId);
  }

  getVersion(versionId) {
    return this.versions.get(versionId);
  }

  requireVersion(versionId) {
    const version = this.versions.get(versionId);
    if (!version) throw new NotFoundError(`版本 ${versionId} 不存在`);
    return version;
  }

  getResourceVersions(resourceId) {
    return (this.versionByResource.get(resourceId) || []).map((id) => this.versions.get(id));
  }

  getContributions(versionId) {
    // 当前生效的申报（撤回不删除，但不再计入权重与署名）
    return (this.contributionsByVersion.get(versionId) || [])
      .map((id) => this.contributions.get(id))
      .filter((c) => !c.withdrawn);
  }

  getAllContributions(versionId) {
    // 含已撤回在内的全部申报：撤回不能删除曾参与旧版本的事实
    return (this.contributionsByVersion.get(versionId) || []).map((id) => this.contributions.get(id));
  }

  getConfirmation(versionId, teacherRef) {
    return this.confirmationByTeacher.get(`${versionId}|${teacherRef}`);
  }

  getDisputes(versionId) {
    return (this.disputesByVersion.get(versionId) || []).map((id) => this.disputes.get(id));
  }

  getOpenDisputes(versionId) {
    return this.getDisputes(versionId).filter((d) => openDisputeStates.includes(d.state));
  }

  isParticipant(versionId, teacherRef) {
    return this.participantKeys.has(`${versionId}|${teacherRef}`);
  }

  /**
   * 每位教师在该版本上的累计权重建议。
   * 权重只来自贡献申报本身；重复确认不增加权重，已撤回申报不计入。
   */
  weightByTeacher(versionId) {
    const totals = new Map();
    const kindsByTeacher = new Map();
    for (const c of this.getContributions(versionId)) {
      totals.set(c.teacherRef, (totals.get(c.teacherRef) || 0) + c.weightSuggestion);
      const kinds = kindsByTeacher.get(c.teacherRef) || [];
      kinds.push(c.kind);
      kindsByTeacher.set(c.teacherRef, kinds);
    }
    return { totals, kindsByTeacher };
  }

  /**
   * 未确认者：已申报有效贡献但本人尚未“同意”的教师。
   */
  unconfirmedFor(versionId) {
    const result = [];
    const seen = new Set();
    for (const c of this.getContributions(versionId)) {
      if (seen.has(c.teacherRef)) continue;
      seen.add(c.teacherRef);
      const confirmation = this.getConfirmation(versionId, c.teacherRef);
      if (!confirmation || confirmation.decision !== 'agreed') {
        result.push({
          teacherRef: c.teacherRef,
          status: confirmation ? confirmation.decision : 'pending',
          note: confirmation?.note ?? null,
        });
      }
    }
    return result;
  }

  /**
   * 署名顺序如何形成：主持人显式裁定的教师按裁定位置排列，
   * 其余教师按累计权重降序、首次申报时间升序补入。
   * 每一位署名都带有排序依据，可以完整还原形成过程。
   */
  authorshipTrail(versionId) {
    const version = this.requireVersion(versionId);
    const decisionLog = this.orderingByVersion.get(versionId) || [];
    const { totals: weights } = this.weightByTeacher(versionId);

    // 同一教师被多次裁定时以最后一次为准
    const latest = new Map();
    for (const d of decisionLog) latest.set(d.teacherRef, d);

    const firstSeen = new Map();
    for (const c of this.getAllContributions(versionId)) {
      if (!firstSeen.has(c.teacherRef)) firstSeen.set(c.teacherRef, c.declaredAt);
    }

    const decided = [...latest.values()]
      .filter((d) => weights.has(d.teacherRef))
      .sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    const decidedRefs = new Set(decided.map((d) => d.teacherRef));

    const rest = [...weights.keys()]
      .filter((ref) => !decidedRefs.has(ref))
      .sort((a, b) => {
        const gap = weights.get(b) - weights.get(a);
        if (gap !== 0) return gap;
        return String(firstSeen.get(a)).localeCompare(String(firstSeen.get(b)));
      });

    let order = 1;
    const trail = [];
    for (const d of decided) {
      trail.push({
        teacherRef: d.teacherRef,
        order: order++,
        basis: d.reason,
        decidedBy: d.decidedBy,
        decidedAt: d.at,
        totalWeight: weights.get(d.teacherRef),
      });
    }
    for (const ref of rest) {
      trail.push({
        teacherRef: ref,
        order: order++,
        basis: '无显式裁定，按累计权重建议排序',
        decidedBy: null,
        decidedAt: null,
        totalWeight: weights.get(ref),
      });
    }
    return {
      versionId,
      resourceId: version.resourceId,
      state: version.state,
      orderingHistory: decisionLog.map((d) => ({
        teacherRef: d.teacherRef,
        order: d.order,
        reason: d.reason,
        decidedBy: d.decidedBy,
        decidedAt: d.at,
      })),
      trail,
    };
  }

  /**
   * 发布门槛检查：达到约定确认范围、无未决异议、无持反对立场者。
   */
  releaseReadiness(versionId) {
    const version = this.requireVersion(versionId);
    const active = this.getContributions(versionId);
    const teacherRefs = new Set(active.map((c) => c.teacherRef));

    const agreedTeachers = new Set();
    const pendingTeachers = new Set();
    const objectingTeachers = new Set();
    for (const ref of teacherRefs) {
      const confirmation = this.getConfirmation(versionId, ref);
      if (!confirmation) pendingTeachers.add(ref);
      else if (confirmation.decision === 'agreed') agreedTeachers.add(ref);
      else objectingTeachers.add(ref);
    }

    const openDisputes = this.getOpenDisputes(versionId);
    const agreedCount = agreedTeachers.size;
    const quorumMet = agreedCount >= version.requiredConfirmations && pendingTeachers.size === 0;
    const disputesClear = openDisputes.length === 0;
    const noObjectors = objectingTeachers.size === 0;

    return {
      versionId,
      state: version.state,
      requiredConfirmations: version.requiredConfirmations,
      agreedCount,
      totalContributors: teacherRefs.size,
      pending: [...pendingTeachers],
      objecting: [...objectingTeachers],
      openDisputes: openDisputes.map((d) => ({
        disputeId: d.disputeId,
        raisedBy: d.raisedBy,
        focus: d.focus,
        basis: d.basis,
        state: d.state,
      })),
      quorumMet,
      disputesClear,
      noObjectors,
      ready: quorumMet && disputesClear && noObjectors,
    };
  }

  // ---- 事件应用 ----

  apply(event) {
    const { type, payload: p, seq, recordedAt } = event;
    switch (type) {
      case 'user-registered':
        this.users.set(p.userId, { ...p });
        break;
      case 'school-registered':
        this.schools.set(p.schoolId, { ...p });
        break;
      case 'resource-created':
        this.resources.set(p.resourceId, {
          resourceId: p.resourceId,
          title: p.title,
          schoolId: p.schoolId,
          rootVersionId: p.rootVersionId,
          confidentialNote: p.confidentialNote ?? null,
          createdAt: recordedAt,
        });
        break;
      case 'version-created': {
        this.versions.set(p.versionId, {
          versionId: p.versionId,
          resourceId: p.resourceId,
          parentVersionId: p.parentVersionId ?? null,
          title: p.title,
          state: 'working',
          requiredConfirmations: p.requiredConfirmations,
          inheritedFromVersionId: p.inheritFrom ?? null,
          branchReason: p.branchReason ?? null,
          createdBy: p.createdBy,
          createdAt: recordedAt,
        });
        const list = this.versionByResource.get(p.resourceId) || [];
        list.push(p.versionId);
        this.versionByResource.set(p.resourceId, list);
        break;
      }
      case 'contribution-declared': {
        this.contributions.set(p.contributionId, {
          contributionId: p.contributionId,
          versionId: p.versionId,
          teacherRef: p.teacherRef,
          kind: p.kind,
          weightSuggestion: p.weightSuggestion,
          detail: p.detail ?? '',
          inherited: p.inherited ?? false,
          inheritedFromVersionId: p.inheritedFromVersionId ?? null,
          declaredAt: p.declaredAt,
          declaredBy: p.declaredBy,
          seq,
          withdrawn: false,
          withdrawnAt: null,
        });
        this.participantKeys.add(`${p.versionId}|${p.teacherRef}`);
        const list = this.contributionsByVersion.get(p.versionId) || [];
        list.push(p.contributionId);
        this.contributionsByVersion.set(p.versionId, list);
        break;
      }
      case 'contribution-withdrawn': {
        const c = this.contributions.get(p.contributionId);
        if (c) {
          c.withdrawn = true;
          c.withdrawnAt = p.withdrawnAt;
          c.withdrawnBy = p.withdrawnBy;
          c.withdrawSeq = seq;
        }
        break;
      }
      case 'confirmation-recorded': {
        this.confirmationByTeacher.set(`${p.versionId}|${p.teacherRef}`, {
          versionId: p.versionId,
          teacherRef: p.teacherRef,
          decision: p.decision,
          note: p.note ?? '',
          inherited: p.inherited ?? false,
          confirmedBy: p.confirmedBy,
          confirmedAt: p.confirmedAt,
          reconfirmCount: 0,
          seq,
        });
        break;
      }
      case 'confirmation-repeated': {
        // 重复确认仅留痕：立场不变、权重不变
        const existing = this.confirmationByTeacher.get(`${p.versionId}|${p.teacherRef}`);
        if (existing) {
          existing.reconfirmCount += 1;
          existing.lastReconfirmAt = p.at;
        }
        break;
      }
      case 'dispute-raised': {
        this.disputes.set(p.disputeId, {
          disputeId: p.disputeId,
          versionId: p.versionId,
          raisedBy: p.raisedBy,
          focus: p.focus,
          basis: p.basis ?? '',
          state: 'raised',
          raisedAt: p.raisedAt,
          seq,
          history: [{ state: 'raised', at: p.raisedAt, by: p.raisedBy, note: p.focus }],
        });
        const list = this.disputesByVersion.get(p.versionId) || [];
        list.push(p.disputeId);
        this.disputesByVersion.set(p.versionId, list);
        this.participantKeys.add(`${p.versionId}|${p.raisedBy}`);
        // 任何参与者提出有依据的异议，立即冻结对应版本（且仅影响该版本）
        const v = this.versions.get(p.versionId);
        if (v && v.state !== 'published' && v.state !== 'frozen') {
          v.state = 'frozen';
          v.frozenSince = p.raisedAt;
        }
        break;
      }
      case 'dispute-responded': {
        const d = this.disputes.get(p.disputeId);
        if (d) {
          d.state = 'responded';
          d.history.push({ state: 'responded', at: p.at, by: p.respondedBy, note: p.note ?? '' });
        }
        break;
      }
      case 'dispute-resolved': {
        const d = this.disputes.get(p.disputeId);
        if (d) {
          d.state = 'resolved';
          d.resolution = p.resolution ?? '';
          d.history.push({ state: 'resolved', at: p.at, by: p.resolvedBy, note: p.resolution ?? '' });
        }
        break;
      }
      case 'dispute-withdrawn': {
        const d = this.disputes.get(p.disputeId);
        if (d) {
          d.state = 'withdrawn';
          d.history.push({ state: 'withdrawn', at: p.at, by: p.withdrawnBy, note: '' });
        }
        break;
      }
      case 'version-unfrozen': {
        const v = this.versions.get(p.versionId);
        if (v && v.state === 'frozen') {
          v.state = 'working';
          delete v.frozenSince;
        }
        break;
      }
      case 'ordering-decided': {
        const list = this.orderingByVersion.get(p.versionId) || [];
        list.push({
          teacherRef: p.teacherRef,
          order: p.order,
          reason: p.reason,
          decidedBy: p.decidedBy,
          at: p.at,
          seq,
        });
        this.orderingByVersion.set(p.versionId, list);
        break;
      }
      case 'release-authorized': {
        this.authorizationByVersion.set(p.versionId, { ...p, seq });
        const v = this.versions.get(p.versionId);
        if (v && v.state !== 'published') v.state = 'authorized';
        break;
      }
      case 'version-published': {
        this.publicationCounter += 1;
        this.publicationByVersion.set(p.versionId, { ...p, serial: this.publicationCounter, seq });
        const v = this.versions.get(p.versionId);
        if (v) v.state = 'published';
        break;
      }
      default:
        // 未知事件忽略，保持日志前向兼容
        break;
    }
  }
}

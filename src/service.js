import { randomUUID } from 'node:crypto';
import { Projection } from './projection.js';
import {
  contributionKinds,
  versionStates,
  disputeStates,
  userRoles,
  weightSuggestionGuide,
} from './domain.js';
import {
  ValidationError,
  PermissionError,
  NotFoundError,
  ConflictError,
} from './errors.js';

const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();

const isNonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * 教研署名协商服务。
 *
 * 所有写操作都先重放事件得到当前投影、校验规则，再追加新事件；
 * 服务本身不持有可变状态，重启后凭事件日志即可还原全部版本图与冻结状态。
 */
export class NegotiationService {
  constructor(eventLog) {
    this.log = eventLog;
  }

  #project() {
    return new Projection(this.log);
  }

  #requireActor(actor) {
    if (!actor || !isNonEmpty(actor.userId)) throw new PermissionError('缺少操作者身份');
    const proj = this.#project();
    const user = proj.getUser(actor.userId);
    if (!user) throw new PermissionError(`身份 ${actor.userId} 未登记`);
    return user;
  }

  #requireFacilitator(actor) {
    const user = this.#requireActor(actor);
    if (user.role !== 'facilitator') throw new PermissionError('该操作仅教研主持人可执行');
    return user;
  }

  // 供 HTTP 层等外部入口复用的角色校验
  assertFacilitator(actor) {
    return this.#requireFacilitator(actor);
  }

  assertRegisteredUser(userId) {
    const proj = this.#project();
    if (!proj.users.has(userId)) throw new ValidationError(`用户 ${userId} 未登记`);
  }

  // ---- 引导与登记 ----

  /**
   * 系统引导：仅在尚无任何登记用户时可用，
   * 建立第一所学校与首位教研主持人。之后的登记均须主持人授权。
   */
  bootstrapFacilitator({ schoolId, schoolName, userId, displayName }) {
    if (!isNonEmpty(schoolId) || !isNonEmpty(schoolName)) throw new ValidationError('学校编号与名称均不能为空');
    if (!isNonEmpty(userId) || !isNonEmpty(displayName)) throw new ValidationError('主持人编号与姓名均不能为空');
    const proj = this.#project();
    if (proj.users.size > 0 || proj.schools.size > 0) {
      throw new ConflictError('系统已完成引导，不能重复引导');
    }
    return this.log.appendBatch([
      { type: 'school-registered', payload: { schoolId, name: schoolName.trim() } },
      {
        type: 'user-registered',
        payload: { userId, displayName: displayName.trim(), schoolId, role: 'facilitator' },
      },
    ]);
  }

  registerSchool(actor, { schoolId, name }) {
    this.#requireFacilitator(actor);
    if (!isNonEmpty(schoolId) || !isNonEmpty(name)) throw new ValidationError('学校编号与名称均不能为空');
    const proj = this.#project();
    if (proj.schools.has(schoolId)) throw new ConflictError(`学校 ${schoolId} 已登记`);
    return this.log.append('school-registered', { schoolId, name: name.trim() });
  }

  registerUser(actor, { userId, displayName, schoolId, role }) {
    this.#requireFacilitator(actor);
    if (!isNonEmpty(userId) || !isNonEmpty(displayName)) throw new ValidationError('用户编号与姓名均不能为空');
    if (!userRoles.includes(role)) throw new ValidationError(`未知角色：${role}`);
    const proj = this.#project();
    if (proj.users.has(userId)) throw new ConflictError(`用户 ${userId} 已登记`);
    if (!proj.schools.has(schoolId)) throw new ValidationError(`学校 ${schoolId} 尚未登记`);
    return this.log.append('user-registered', {
      userId,
      displayName: displayName.trim(),
      schoolId,
      role,
    });
  }

  // ---- 资源与版本 ----

  createResource(actor, { resourceId, title, schoolId, confidentialNote = null, requiredConfirmations = 1 }) {
    const user = this.#requireActor(actor);
    if (user.role !== 'facilitator' && user.role !== 'coordination') {
      throw new PermissionError('仅主持人或学校统筹人可建立资源');
    }
    if (!isNonEmpty(resourceId) || !isNonEmpty(title)) throw new ValidationError('资源编号与标题均不能为空');
    if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
      throw new ValidationError('约定确认人数必须为不小于 1 的整数');
    }
    const proj = this.#project();
    if (proj.resources.has(resourceId)) throw new ConflictError(`资源 ${resourceId} 已存在`);
    if (!proj.schools.has(schoolId)) throw new ValidationError(`学校 ${schoolId} 尚未登记`);
    if (user.role === 'coordination' && user.schoolId !== schoolId) {
      throw new PermissionError('学校统筹人只能为本校建立资源');
    }
    const rootVersionId = `${resourceId}-V1`;
    const events = [
      {
        type: 'resource-created',
        payload: {
          resourceId,
          title: title.trim(),
          schoolId,
          rootVersionId,
          confidentialNote: confidentialNote ?? null,
        },
      },
      {
        type: 'version-created',
        payload: this.#versionPayload({
          versionId: rootVersionId,
          resourceId,
          parentVersionId: null,
          inheritFromVersionId: null,
          title: `${title.trim()}（初稿）`,
          requiredConfirmations,
          branchReason: null,
          createdBy: user.userId,
        }),
      },
    ];
    return this.log.appendBatch(events);
  }

  #versionPayload({
    versionId,
    resourceId,
    parentVersionId,
    inheritFromVersionId,
    title,
    requiredConfirmations,
    branchReason,
    createdBy,
  }) {
    return {
      versionId,
      resourceId,
      parentVersionId,
      inheritFrom: inheritFromVersionId,
      title,
      requiredConfirmations,
      branchReason,
      createdBy,
    };
  }

  /**
   * 从父版本分叉出新版本。
   * 新版本拥有独立的协商与冻结状态（内容分叉后分别协商）；
   * 若声明继承，则把父版本中“教师本人已同意且未撤回”的贡献及其同意立场
   * 复制到新版本，复制件标注 inherited 来源。
   */
  createVersion(actor, input) {
    const user = this.#requireActor(actor);
    if (user.role !== 'facilitator' && user.role !== 'coordination') {
      throw new PermissionError('仅主持人或学校统筹人可建立版本');
    }
    const {
      resourceId,
      versionId,
      parentVersionId,
      title,
      requiredConfirmations,
      branchReason = null,
      inherit = true,
    } = input;

    if (!isNonEmpty(versionId) || !isNonEmpty(parentVersionId)) {
      throw new ValidationError('新版本编号与父版本编号均不能为空');
    }
    if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
      throw new ValidationError('约定确认人数必须为不小于 1 的整数');
    }
    const proj = this.#project();
    const resource = proj.resources.get(resourceId);
    if (!resource) throw new NotFoundError(`资源 ${resourceId} 不存在`);
    if (proj.versions.has(versionId)) throw new ConflictError(`版本 ${versionId} 已存在`);
    const parent = proj.versions.get(parentVersionId);
    if (!parent) throw new NotFoundError(`父版本 ${parentVersionId} 不存在`);
    if (parent.resourceId !== resourceId) {
      throw new ValidationError('父版本不属于该资源，不能跨资源分叉');
    }
    if (user.role === 'coordination' && user.schoolId !== resource.schoolId) {
      throw new PermissionError('学校统筹人只能就本校资源建立版本');
    }

    const events = [
      {
        type: 'version-created',
        payload: this.#versionPayload({
          versionId,
          resourceId,
          parentVersionId,
          inheritFromVersionId: inherit ? parentVersionId : null,
          title: isNonEmpty(title) ? title.trim() : `${parent.title} 的修订版`,
          requiredConfirmations,
          branchReason,
          createdBy: user.userId,
        }),
      },
    ];

    if (inherit) {
      // 仅继承：当前有效 且 教师本人已“同意”的贡献；立场每位教师只继承一条
      const inheritedTeachers = new Set();
      for (const c of proj.getContributions(parentVersionId)) {
        const confirmation = proj.getConfirmation(parentVersionId, c.teacherRef);
        if (!confirmation || confirmation.decision !== 'agreed') continue;
        events.push({
          type: 'contribution-declared',
          payload: {
            contributionId: id('C'),
            versionId,
            teacherRef: c.teacherRef,
            kind: c.kind,
            weightSuggestion: c.weightSuggestion,
            detail: c.detail,
            inherited: true,
            inheritedFromVersionId: parentVersionId,
            declaredAt: now(),
            declaredBy: user.userId,
          },
        });
        if (!inheritedTeachers.has(c.teacherRef)) {
          inheritedTeachers.add(c.teacherRef);
          events.push({
            type: 'confirmation-recorded',
            payload: {
              versionId,
              teacherRef: c.teacherRef,
              decision: 'agreed',
              note: '随已确认贡献继承的立场',
              inherited: true,
              confirmedBy: c.teacherRef,
              confirmedAt: now(),
            },
          });
        }
      }
    }

    return this.log.appendBatch(events);
  }

  // ---- 贡献申报 ----

  declareContribution(actor, input) {
    const user = this.#requireActor(actor);
    const { versionId, teacherRef, kind, weightSuggestion, detail = '' } = input;
    if (!isNonEmpty(teacherRef)) throw new ValidationError('缺少申报教师');
    if (!contributionKinds.includes(kind)) throw new ValidationError(`未知贡献类型：${kind}`);
    const w = Number(weightSuggestion);
    if (!Number.isFinite(w) || w <= 0 || w > 1) throw new ValidationError('权重建议须为 (0, 1] 之间的数值');
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布，不可再申报贡献');
    if (version.state === 'frozen') throw new ConflictError('版本因异议已冻结，须先了结异议');
    if (version.state === 'authorized') throw new ConflictError('版本已授权，冻结或重新分叉后才能调整贡献');

    // 教师只能申报本人贡献；主持人/统筹人可代为申报
    const onBehalf = user.userId !== teacherRef;
    if (onBehalf && user.role === 'teacher') {
      throw new PermissionError('教师只能申报本人的贡献');
    }
    if (onBehalf && !proj.getUser(teacherRef)) {
      throw new ValidationError(`被申报教师 ${teacherRef} 未登记`);
    }

    return this.log.append('contribution-declared', {
      contributionId: id('C'),
      versionId,
      teacherRef,
      kind,
      weightSuggestion: w,
      detail,
      inherited: false,
      inheritedFromVersionId: null,
      declaredAt: now(),
      declaredBy: user.userId,
    });
  }

  /**
   * 撤回贡献：只追加撤回事件并在读模型置标记，
   * 申报事实与该教师曾参与旧版本的历史永远保留。
   */  withdrawContribution(actor, { contributionId }) {
    const user = this.#requireActor(actor);
    const proj = this.#project();
    const contribution = proj.contributions.get(contributionId);
    if (!contribution) throw new NotFoundError(`贡献 ${contributionId} 不存在`);
    if (contribution.withdrawn) throw new ConflictError('该贡献已经撤回');
    const version = proj.requireVersion(contribution.versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布，发布摘要不可改写');
    if (user.userId !== contribution.teacherRef && user.role !== 'facilitator') {
      throw new PermissionError('只能撤回本人的贡献，或由主持人撤回');
    }
    return this.log.append('contribution-withdrawn', {
      contributionId,
      versionId: contribution.versionId,
      teacherRef: contribution.teacherRef,
      withdrawnAt: now(),
      withdrawnBy: user.userId,
    });
  }

  // ---- 立场确认（共同确认 / 表达不同意见）----

  /**
   * 教师对具体版本表达立场。
   * decision=agreed 为共同确认，objected 为对该版本的不同意见。
   * 同一教师重复相同确认仅追加留痕事件：立场不变、权重不增加。
   */  confirm(actor, { versionId, decision, note = '' }) {
    const user = this.#requireActor(actor);
    if (decision !== 'agreed' && decision !== 'objected') {
      throw new ValidationError('立场只能是 agreed 或 objected');
    }
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布');
    if (version.state === 'frozen') throw new ConflictError('版本已冻结，待异议了结后再确认');
    if (version.state === 'authorized' && decision !== 'objected') {
      throw new ConflictError('版本已授权，不能再追加确认');
    }
    if (!proj.isParticipant(versionId, user.userId)) {
      throw new PermissionError('只有该版本的参与者可对其表态');
    }

    const existing = proj.getConfirmation(versionId, user.userId);
    if (existing && existing.decision === decision) {
      // 重复确认不增加权重：仅记录一次留痕
      return this.log.append('confirmation-repeated', {
        versionId,
        teacherRef: user.userId,
        decision,
        at: now(),
        repeatedBy: user.userId,
      });
    }

    return this.log.append('confirmation-recorded', {
      versionId,
      teacherRef: user.userId,
      decision,
      note,
      inherited: false,
      confirmedBy: user.userId,
      confirmedAt: now(),
    });
  }

  // ---- 异议与冻结 ----

  /**
   * 提出有依据的异议。任何参与者均可提出；basis 必须给出依据。
   * 一旦提出，对应版本立即冻结，其他版本/分支不受影响。
   */  raiseDispute(actor, { versionId, focus, basis }) {
    const user = this.#requireActor(actor);
    if (!isNonEmpty(focus)) throw new ValidationError('异议焦点不能为空');
    if (!isNonEmpty(basis)) throw new ValidationError('异议必须附带依据，无依据的反对不能冻结版本');
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布，不可再提异议；请从该版本分叉后协商');
    if (!proj.isParticipant(versionId, user.userId)) {
      throw new PermissionError('只有该版本的参与者可提出异议');
    }
    return this.log.append('dispute-raised', {
      disputeId: id('D'),
      versionId,
      raisedBy: user.userId,
      focus: focus.trim(),
      basis: basis.trim(),
      raisedAt: now(),
    });
  }

  respondDispute(actor, { disputeId, note }) {
    const user = this.#requireActor(actor);
    if (user.role !== 'facilitator' && user.role !== 'coordination') {
      throw new PermissionError('仅主持人或学校统筹人可回应异议');
    }
    if (!isNonEmpty(note)) throw new ValidationError('回应内容不能为空');
    const proj = this.#project();
    const dispute = proj.disputes.get(disputeId);
    if (!dispute) throw new NotFoundError(`异议 ${disputeId} 不存在`);
    if (dispute.state !== 'raised') throw new ConflictError(`异议当前为 ${dispute.state}，无需回应`);
    return this.log.append('dispute-responded', {
      disputeId,
      versionId: dispute.versionId,
      respondedBy: user.userId,
      note: note.trim(),
      at: now(),
    });
  }

  resolveDispute(actor, { disputeId, resolution }) {
    const user = this.#requireFacilitator(actor);
    if (!isNonEmpty(resolution)) throw new ValidationError('处理结论不能为空');
    const proj = this.#project();
    const dispute = proj.disputes.get(disputeId);
    if (!dispute) throw new NotFoundError(`异议 ${disputeId} 不存在`);
    if (dispute.state === 'resolved' || dispute.state === 'withdrawn') {
      throw new ConflictError(`异议已经${dispute.state === 'resolved' ? '解决' : '撤回'}`);
    }
    return this.log.append('dispute-resolved', {
      disputeId,
      versionId: dispute.versionId,
      resolvedBy: user.userId,
      resolution: resolution.trim(),
      at: now(),
    });
  }

  withdrawDispute(actor, { disputeId }) {
    const user = this.#requireActor(actor);
    const proj = this.#project();
    const dispute = proj.disputes.get(disputeId);
    if (!dispute) throw new NotFoundError(`异议 ${disputeId} 不存在`);
    if (dispute.state === 'resolved' || dispute.state === 'withdrawn') {
      throw new ConflictError('该异议已了结');
    }
    if (user.userId !== dispute.raisedBy && user.role !== 'facilitator') {
      throw new PermissionError('只能由提出人撤回异议，或由主持人撤回');
    }
    return this.log.append('dispute-withdrawn', {
      disputeId,
      versionId: dispute.versionId,
      withdrawnBy: user.userId,
      at: now(),
    });
  }

  /**
   * 解冻：仅当版本上已无未决异议，且当前处于冻结状态时，主持人可解除冻结。
   * 冻结只针对具体版本，故解冻也不触碰任何其他分支。
   */  unfreeze(actor, { versionId }) {
    const user = this.#requireFacilitator(actor);
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state !== 'frozen') throw new ConflictError('该版本当前不在冻结状态');
    const open = proj.getOpenDisputes(versionId);
    if (open.length > 0) {
      throw new ConflictError(`仍有 ${open.length} 条未决异议，不能解冻`);
    }
    return this.log.append('version-unfrozen', {
      versionId,
      unfrozenBy: user.userId,
      at: now(),
    });
  }

  // ---- 署名顺序裁定 ----

  decideOrdering(actor, { versionId, entries }) {
    const user = this.#requireFacilitator(actor);
    if (!Array.isArray(entries) || entries.length === 0) throw new ValidationError('至少指定一条署名位置');
    const orders = new Set();
    for (const e of entries) {
      if (!isNonEmpty(e.teacherRef) || !Number.isInteger(e.order) || e.order < 1) {
        throw new ValidationError('每条署名位置需包含教师与不小于 1 的序号');
      }
      if (orders.has(e.order)) throw new ValidationError(`署名序号 ${e.order} 重复`);
      orders.add(e.order);
    }
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布，署名顺序不可再调整');
    if (version.state === 'frozen') throw new ConflictError('版本已冻结，不能调整署名顺序');

    const events = entries.map((e) => ({
      type: 'ordering-decided',
      payload: {
        versionId,
        teacherRef: e.teacherRef,
        order: e.order,
        reason: isNonEmpty(e.reason) ? e.reason.trim() : '主持人裁定',
        decidedBy: user.userId,
        at: now(),
      },
    }));
    return this.log.appendBatch(events);
  }

  // ---- 发布授权与发布摘要 ----

  /**
   * 主持人授权发布。门槛：达到约定确认范围、无未决异议、无持反对立场者。
   */  authorize(actor, { versionId }) {
    const user = this.#requireFacilitator(actor);
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布');
    const readiness = proj.releaseReadiness(versionId);
    if (!readiness.ready) {
      const blockers = [];
      if (!readiness.quorumMet) {
        blockers.push(
          `确认范围不足：已同意 ${readiness.agreedCount}/${readiness.requiredConfirmations}，未表态 ${readiness.pending.join('、') || '无'}`
        );
      }
      if (!readiness.disputesClear) {
        blockers.push(`存在 ${readiness.openDisputes.length} 条未决异议`);
      }
      if (!readiness.noObjectors) {
        blockers.push(`仍有持反对立场者：${readiness.objecting.join('、')}`);
      }
      throw new ConflictError(`暂不满足发布条件：${blockers.join('；')}`);
    }
    return this.log.append('release-authorized', {
      versionId,
      resourceId: version.resourceId,
      authorizedBy: user.userId,
      at: now(),
      readinessSnapshot: readiness,
    });
  }

  /**
   * 签发发布摘要。必须先经授权且授权后条件未被破坏。
   * 发布后版本不可改写。
   */  publish(actor, { versionId }) {
    const user = this.#requireFacilitator(actor);
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    if (version.state === 'published') throw new ConflictError('版本已发布，发布摘要不可重复签发');
    const authorization = proj.authorizationByVersion.get(versionId);
    if (!authorization || version.state !== 'authorized') {
      throw new ConflictError('版本尚未完成发布授权');
    }
    const readiness = proj.releaseReadiness(versionId);
    if (!readiness.ready) throw new ConflictError('授权后出现新的未决事项，不能发布');

    const resource = proj.resources.get(version.resourceId);
    const trail = proj.authorshipTrail(versionId);
    const school = proj.schools.get(resource.schoolId);
    const { totals, kindsByTeacher } = proj.weightByTeacher(versionId);

    const authorship = trail.trail.map((entry) => {
      const teacher = proj.getUser(entry.teacherRef);
      return {
        order: entry.order,
        teacherRef: entry.teacherRef,
        displayName: teacher?.displayName ?? null,
        schoolId: teacher?.schoolId ?? null,
        contributions: kindsByTeacher.get(entry.teacherRef) || [],
        totalWeightSuggestion: Number(totals.get(entry.teacherRef).toFixed(4)),
        orderingBasis: entry.basis,
        orderingDecidedAt: entry.decidedAt,
      };
    });

    const summary = {
      summaryId: id('PUB'),
      resourceId: version.resourceId,
      resourceTitle: resource.title,
      versionId,
      parentVersionId: version.parentVersionId,
      school: { schoolId: resource.schoolId, name: school?.name ?? null },
      authorship,
      requiredConfirmations: version.requiredConfirmations,
      agreedCount: readiness.agreedCount,
      disputesResolved: readiness.disputesClear,
      openDisputeCount: readiness.openDisputes.length,
      authorizedBy: authorization.authorizedBy,
      authorizedAt: authorization.at,
      publishedBy: user.userId,
      publishedAt: now(),
    };

    this.log.append('version-published', summary);
    return summary;
  }

  // ---- 查询 ----

  getVersionGraph(actor, resourceId) {
    const user = this.#requireActor(actor);
    const proj = this.#project();
    const resource = proj.resources.get(resourceId);
    if (!resource) throw new NotFoundError(`资源 ${resourceId} 不存在`);
    const versions = proj.getResourceVersions(resourceId).map((v) => {
      const readiness = proj.releaseReadiness(v.versionId);
      return {
        versionId: v.versionId,
        parentVersionId: v.parentVersionId,
        title: v.title,
        state: v.state,
        requiredConfirmations: v.requiredConfirmations,
        inheritedFromVersionId: v.inheritedFromVersionId,
        branchReason: v.branchReason,
        createdAt: v.createdAt,
        openDisputeCount: proj.getOpenDisputes(v.versionId).length,
        unconfirmed: proj.unconfirmedFor(v.versionId),
        readiness: {
          agreedCount: readiness.agreedCount,
          ready: readiness.ready,
          quorumMet: readiness.quorumMet,
          disputesClear: readiness.disputesClear,
        },
      };
    });
    return {
      resourceId,
      title: resource.title,
      schoolId: resource.schoolId,
      rootVersionId: resource.rootVersionId,
      versions,
    };
  }

  /**
   * 读取资源详情。保密说明仅主持人或本校统筹人可见；
   * 权限不足时该字段直接缺省，而不是返回内容。
   */  getResource(actor, resourceId) {
    const user = this.#requireActor(actor);
    const proj = this.#project();
    const resource = proj.resources.get(resourceId);
    if (!resource) throw new NotFoundError(`资源 ${resourceId} 不存在`);
    const canSeeNote =
      user.role === 'facilitator' ||
      (user.role === 'coordination' && user.schoolId === resource.schoolId);
    return {
      resourceId: resource.resourceId,
      title: resource.title,
      schoolId: resource.schoolId,
      rootVersionId: resource.rootVersionId,
      createdAt: resource.createdAt,
      ...(canSeeNote ? { confidentialNote: resource.confidentialNote } : {}),
    };
  }

  getVersionDetail(actor, versionId) {
    this.#requireActor(actor);
    const proj = this.#project();
    const version = proj.requireVersion(versionId);
    const readiness = proj.releaseReadiness(versionId);
    return {
      ...version,
      contributions: proj.getAllContributions(versionId).map((c) => ({
        contributionId: c.contributionId,
        teacherRef: c.teacherRef,
        kind: c.kind,
        weightSuggestion: c.weightSuggestion,
        detail: c.detail,
        inherited: c.inherited,
        inheritedFromVersionId: c.inheritedFromVersionId,
        declaredAt: c.declaredAt,
        declaredBy: c.declaredBy,
        withdrawn: c.withdrawn,
        withdrawnAt: c.withdrawnAt,
      })),
      weightByTeacher: [...proj.weightByTeacher(versionId).totals.entries()].map(([teacherRef, w]) => ({
        teacherRef,
        totalWeightSuggestion: Number(w.toFixed(4)),
      })),
      confirmations: [...new Set(proj.getAllContributions(versionId).map((c) => c.teacherRef))]
        .map((ref) => {
          const cf = proj.getConfirmation(versionId, ref);
          return cf
            ? {
                teacherRef: ref,
                decision: cf.decision,
                note: cf.note,
                inherited: cf.inherited,
                confirmedAt: cf.confirmedAt,
                reconfirmCount: cf.reconfirmCount,
              }
            : { teacherRef: ref, decision: 'pending' };
        }),
      disputes: proj.getDisputes(versionId),
      unconfirmed: proj.unconfirmedFor(versionId),
      readiness,
      authorization: proj.authorizationByVersion.get(versionId) ?? null,
      publication: proj.publicationByVersion.get(versionId) ?? null,
    };
  }

  getAuthorshipTrail(actor, versionId) {
    this.#requireActor(actor);
    const proj = this.#project();
    const trail = proj.authorshipTrail(versionId);
    return {
      ...trail,
      trail: trail.trail.map((entry) => {
        const teacher = proj.getUser(entry.teacherRef);
        return { ...entry, displayName: teacher?.displayName ?? null, schoolId: teacher?.schoolId ?? null };
      }),
    };
  }

  /**
   * 版本的完整证据时间线：按事件序号列出与该版本有关的全部事实，
   * 用于还原署名顺序、确认过程与异议处置的来龙去脉。
   */  getEvidence(actor, versionId) {
    this.#requireActor(actor);
    const proj = this.#project();
    proj.requireVersion(versionId);
    const events = [];
    for (const event of this.log) {
      const p = event.payload || {};
      if (p.versionId === versionId || p.parentVersionId === versionId) {
        events.push({ seq: event.seq, recordedAt: event.recordedAt, type: event.type, payload: p });
      }
    }
    return { versionId, events };
  }

  // 权重建议区间参考（领域约定）
  static get weightGuide() {
    return weightSuggestionGuide;
  }
}

export { versionStates, disputeStates };

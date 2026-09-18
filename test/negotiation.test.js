import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld } from './helpers.js';
import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { PermissionError, ConflictError, ValidationError, NotFoundError } from '../src/errors.js';

const F = { userId: 'F-1' };
const C1 = { userId: 'C-1' };
const C2 = { userId: 'C-2' };
const T11 = { userId: 'T-11' };
const T12 = { userId: 'T-12' };
const T21 = { userId: 'T-21' };

function createResourceForTests(service) {
  service.createResource(F, {
    resourceId: 'RES-1',
    title: '单元教学设计',
    schoolId: 'S1',
    requiredConfirmations: 2,
    confidentialNote: '保密：含未公开考试数据',
  });
}

function declareBoth(service, versionId = 'RES-1-V1') {
  const a = service.declareContribution(T11, {
    versionId,
    teacherRef: 'T-11',
    kind: 'authoring',
    weightSuggestion: 0.6,
    detail: '主笔',
  });
  const b = service.declareContribution(T12, {
    versionId,
    teacherRef: 'T-12',
    kind: 'review',
    weightSuggestion: 0.2,
  });
  return { a, b };
}

test('登记与角色：教师不能登记用户，外校统筹不能为本校建资源', () => {
  const { service } = setupWorld();
  assert.throws(() => service.registerUser(T11, { userId: 'X', displayName: 'x', schoolId: 'S1', role: 'teacher' }), PermissionError);
  assert.throws(
    () => service.createResource(C2, { resourceId: 'R', title: 't', schoolId: 'S1' }),
    PermissionError
  );
});

test('完整协商流程：申报→共同确认→授权→发布摘要', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);

  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });

  const readiness = service.getVersionDetail(F, 'RES-1-V1').readiness;
  assert.equal(readiness.quorumMet, true);
  assert.equal(readiness.disputesClear, true);
  assert.equal(readiness.ready, true);

  service.authorize(F, { versionId: 'RES-1-V1' });
  const summary = service.publish(F, { versionId: 'RES-1-V1' });

  assert.equal(summary.versionId, 'RES-1-V1');
  assert.equal(summary.authorship.length, 2);
  // 默认按累计权重降序：T-11(0.6) 在 T-12(0.2) 之前
  assert.deepEqual(summary.authorship.map((a) => a.teacherRef), ['T-11', 'T-12']);
  assert.equal(summary.authorship[0].totalWeightSuggestion, 0.6);
  assert.equal(summary.school.schoolId, 'S1');

  const after = service.getVersionDetail(F, 'RES-1-V1');
  assert.equal(after.state, 'published');
});

test('未达约定确认范围不能授权；未确认者可见', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });

  const detail = service.getVersionDetail(F, 'RES-1-V1');
  assert.deepEqual(detail.unconfirmed.map((u) => u.teacherRef), ['T-12']);
  assert.equal(detail.readiness.quorumMet, false);
  assert.throws(() => service.authorize(F, { versionId: 'RES-1-V1' }), ConflictError);
});

test('重复确认不改变立场、不增加权重，仅留痕', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });

  const detail = service.getVersionDetail(F, 'RES-1-V1');
  const cf = detail.confirmations.find((c) => c.teacherRef === 'T-11');
  assert.equal(cf.decision, 'agreed');
  assert.equal(cf.reconfirmCount, 2);
  const w = detail.weightByTeacher.find((x) => x.teacherRef === 'T-11');
  assert.equal(w.totalWeightSuggestion, 0.6);
});

test('持反对立场者阻止发布门槛', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'objected', note: '权重建议不认可' });

  const r = service.getVersionDetail(F, 'RES-1-V1').readiness;
  assert.deepEqual(r.objecting, ['T-12']);
  assert.equal(r.ready, false);
  assert.throws(() => service.authorize(F, { versionId: 'RES-1-V1' }), ConflictError);
});

test('有依据的异议立即冻结版本，且不影响其他分支', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });

  // 从 V1 分叉 V2（继承已确认贡献）
  service.createVersion(F, {
    resourceId: 'RES-1',
    versionId: 'RES-1-V2',
    parentVersionId: 'RES-1-V1',
    title: 'V2 修订',
    requiredConfirmations: 2,
    branchReason: '调整课堂验证部分',
  });

  // 在 V2 上 T-11 提出有依据异议
  service.raiseDispute(T11, {
    versionId: 'RES-1-V2',
    focus: '继承的作者权重',
    basis: '课堂验证由 T-21 完成，原记录遗漏',
  });

  assert.equal(service.getVersionDetail(F, 'RES-1-V2').state, 'frozen');
  // V1 不受影响，仍可发布
  assert.equal(service.getVersionDetail(F, 'RES-1-V1').state, 'working');
  service.authorize(F, { versionId: 'RES-1-V1' });
  const pub = service.publish(F, { versionId: 'RES-1-V1' });
  assert.ok(pub.summaryId);

  // 冻结版本上不能申报、不能确认
  assert.throws(
    () => service.declareContribution(T12, { versionId: 'RES-1-V2', teacherRef: 'T-12', kind: 'review', weightSuggestion: 0.1 }),
    ConflictError
  );
  assert.throws(() => service.confirm(T12, { versionId: 'RES-1-V2', decision: 'agreed' }), ConflictError);

  // 无依据的异议被拒绝
  assert.throws(
    () => service.raiseDispute(T12, { versionId: 'RES-1-V1', focus: 'x', basis: '   ' }),
    ValidationError
  );

  // 非参与者不能提异议
  assert.throws(
    () => service.raiseDispute(T21, { versionId: 'RES-1-V2', focus: 'x', basis: '依据' }),
    PermissionError
  );
});

test('异议解决前不能解冻/授权；撤回异议且无其他未决项后可解冻', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  const d = service.raiseDispute(T11, {
    versionId: 'RES-1-V1',
    focus: '署名顺序',
    basis: '主笔比例应重新核算',
  });
  const disputeId = d.payload.disputeId;

  assert.throws(() => service.unfreeze(F, { versionId: 'RES-1-V1' }), ConflictError);

  service.respondDispute(C1, { disputeId, note: '已核对原稿' });
  // 主持人不能代普通教师回应
  assert.throws(() => service.resolveDispute(C1, { disputeId, resolution: '维持' }), PermissionError);
  service.resolveDispute(F, { disputeId, resolution: '重新核算后调整顺序' });
  service.unfreeze(F, { versionId: 'RES-1-V1' });
  assert.equal(service.getVersionDetail(F, 'RES-1-V1').state, 'working');
});

test('撤回异议（提出人）也能清除冻结，且异议记录保留', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  const d = service.raiseDispute(T11, { versionId: 'RES-1-V1', focus: 'f', basis: 'b' });
  const disputeId = d.payload.disputeId;
  service.withdrawDispute(T11, { disputeId });
  service.unfreeze(F, { versionId: 'RES-1-V1' });

  const disputes = service.getVersionDetail(F, 'RES-1-V1').disputes;
  assert.equal(disputes[0].state, 'withdrawn');
});

test('撤回贡献不删除曾参与事实：旧版本发布后仍在证据中', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  const declared = declareBoth(service);
  const contributionId = declared.a.payload.contributionId;

  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.authorize(F, { versionId: 'RES-1-V1' });
  service.publish(F, { versionId: 'RES-1-V1' });

  // 发布后不能撤回（摘要不可改写）
  assert.throws(() => service.withdrawContribution(T11, { contributionId }), ConflictError);

  // 另起版本演示撤回留痕
  service.createVersion(F, {
    resourceId: 'RES-1',
    versionId: 'RES-1-V2',
    parentVersionId: 'RES-1-V1',
    requiredConfirmations: 2,
    inherit: false,
  });
  const c2 = service.declareContribution(T11, {
    versionId: 'RES-1-V2',
    teacherRef: 'T-11',
    kind: 'authoring',
    weightSuggestion: 0.5,
  });
  const c2id = c2.payload.contributionId;
  service.withdrawContribution(T11, { contributionId: c2id });

  const all = service.getVersionDetail(F, 'RES-1-V2');
  const withdrawn = all.contributions.find((c) => c.contributionId === c2id);
  assert.equal(withdrawn.withdrawn, true);
  assert.ok(withdrawn.withdrawnAt);
  // 有效贡献为空，但全部申报仍可查
  assert.equal(all.readiness.totalContributors, 0);

  // 旧版本的申报事实依然完整
  const v1 = service.getVersionDetail(F, 'RES-1-V1');
  assert.ok(v1.contributions.some((c) => c.teacherRef === 'T-11'));
});

test('不能撤回他人贡献（主持人除外）', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  const { a } = declareBoth(service);
  assert.throws(() => service.withdrawContribution(T12, { contributionId: a.payload.contributionId }), PermissionError);
});

test('新版本继承已确认贡献及其立场；未确认/反对的不继承', () => {
  const { service } = setupWorld();
  service.createResource(F, { resourceId: 'RES-2', title: '资源二', schoolId: 'S1', requiredConfirmations: 2 });
  service.declareContribution(T11, { versionId: 'RES-2-V1', teacherRef: 'T-11', kind: 'authoring', weightSuggestion: 0.5 });
  service.declareContribution(T12, { versionId: 'RES-2-V1', teacherRef: 'T-12', kind: 'review', weightSuggestion: 0.2 });
  service.declareContribution(T21, { versionId: 'RES-2-V1', teacherRef: 'T-21', kind: 'classroom-validation', weightSuggestion: 0.3 });
  service.confirm(T11, { versionId: 'RES-2-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-2-V1', decision: 'agreed' });
  // T-21 未确认

  service.createVersion(F, {
    resourceId: 'RES-2',
    versionId: 'RES-2-V2',
    parentVersionId: 'RES-2-V1',
    requiredConfirmations: 2,
  });

  const v2 = service.getVersionDetail(F, 'RES-2-V2');
  const refs = v2.contributions.map((c) => c.teacherRef).sort();
  assert.deepEqual(refs, ['T-11', 'T-12']);
  assert.ok(v2.contributions.every((c) => c.inherited === true));
  const inheritedConf = v2.confirmations.filter((c) => c.teacherRef !== 'T-21');
  assert.ok(inheritedConf.every((c) => c.decision === 'agreed' && c.inherited === true));
  // 继承来的立场已满足确认范围
  assert.equal(v2.readiness.agreedCount, 2);
});

test('内容分叉后分别协商：V2 的异议与冻结不波及 V3', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });

  for (const vid of ['RES-1-V2', 'RES-1-V3']) {
    service.createVersion(F, {
      resourceId: 'RES-1',
      versionId: vid,
      parentVersionId: 'RES-1-V1',
      requiredConfirmations: 2,
    });
  }

  service.raiseDispute(T11, { versionId: 'RES-1-V2', focus: '争议焦点A', basis: '依据A' });
  const graph = service.getVersionGraph(F, 'RES-1');
  const byId = Object.fromEntries(graph.versions.map((v) => [v.versionId, v]));
  assert.equal(byId['RES-1-V2'].state, 'frozen');
  assert.equal(byId['RES-1-V3'].state, 'working');
  assert.equal(byId['RES-1-V2'].openDisputeCount, 1);
  assert.equal(byId['RES-1-V3'].openDisputeCount, 0);
});

test('署名顺序可显式裁定，并能还原形成过程', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  // T-12 权重更高但主持人裁定 T-11 居首（主笔）
  service.declareContribution(T11, { versionId: 'RES-1-V1', teacherRef: 'T-11', kind: 'authoring', weightSuggestion: 0.4 });
  service.declareContribution(T12, { versionId: 'RES-1-V1', teacherRef: 'T-12', kind: 'authoring', weightSuggestion: 0.5 });
  service.decideOrdering(F, {
    versionId: 'RES-1-V1',
    entries: [
      { teacherRef: 'T-11', order: 1, reason: '主笔，框架设计人' },
      { teacherRef: 'T-12', order: 2, reason: '章节修订' },
    ],
  });

  const trail = service.getAuthorshipTrail(F, 'RES-1-V1');
  assert.deepEqual(trail.trail.map((t) => t.teacherRef), ['T-11', 'T-12']);
  assert.equal(trail.trail[0].basis, '主笔，框架设计人');
  assert.equal(trail.trail[0].decidedBy, 'F-1');
  // 即使权重较低，裁定位置仍生效
  assert.ok(trail.trail[0].totalWeight < trail.trail[1].totalWeight);

  // 普通教师不能裁定顺序
  assert.throws(
    () => service.decideOrdering(T11, { versionId: 'RES-1-V1', entries: [{ teacherRef: 'T-11', order: 1 }] }),
    PermissionError
  );
});

test('证据时间线还原署名顺序与争议焦点', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.raiseDispute(T11, { versionId: 'RES-1-V1', focus: '争议焦点X', basis: '依据X' });

  const evidence = service.getEvidence(F, 'RES-1-V1');
  const types = evidence.events.map((e) => e.type);
  assert.ok(types.includes('contribution-declared'));
  assert.ok(types.includes('dispute-raised'));
  const disputeEvent = evidence.events.find((e) => e.type === 'dispute-raised');
  assert.equal(disputeEvent.payload.focus, '争议焦点X');
});

test('保密说明：主持人可见、本校统筹可见、教师与外校统筹不可见', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  assert.equal(service.getResource(F, 'RES-1').confidentialNote, '保密：含未公开考试数据');
  assert.equal(service.getResource(C1, 'RES-1').confidentialNote, '保密：含未公开考试数据');
  assert.equal('confidentialNote' in service.getResource(T11, 'RES-1'), false);
  assert.equal('confidentialNote' in service.getResource(C2, 'RES-1'), false);
});

test('发布后版本不可改写：不能再申报、授权或发布', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.authorize(F, { versionId: 'RES-1-V1' });
  service.publish(F, { versionId: 'RES-1-V1' });

  assert.throws(
    () => service.declareContribution(T11, { versionId: 'RES-1-V1', teacherRef: 'T-11', kind: 'review', weightSuggestion: 0.1 }),
    ConflictError
  );
  assert.throws(() => service.authorize(F, { versionId: 'RES-1-V1' }), ConflictError);
  assert.throws(() => service.publish(F, { versionId: 'RES-1-V1' }), ConflictError);
});

test('授权后出现新异议则不能发布', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  declareBoth(service);
  service.confirm(T11, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.confirm(T12, { versionId: 'RES-1-V1', decision: 'agreed' });
  service.authorize(F, { versionId: 'RES-1-V1' });
  // 授权后版本为 authorized，参与者通过提异议冻结（raiseDispute 允许非 published）
  service.raiseDispute(T12, { versionId: 'RES-1-V1', focus: '临时异议', basis: '新依据' });
  assert.equal(service.getVersionDetail(F, 'RES-1-V1').state, 'frozen');
  assert.throws(() => service.publish(F, { versionId: 'RES-1-V1' }), ConflictError);
});

test('未经认证/未知身份被拒绝', () => {
  const { service } = setupWorld();
  assert.throws(() => service.getVersionGraph({ userId: 'GHOST' }, 'RES-1'), PermissionError);
  assert.throws(() => service.getVersionGraph({}, 'RES-1'), PermissionError);
  assert.throws(() => service.getVersionDetail(F, 'NOPE'), NotFoundError);
});

test('权重建议超出 (0,1] 被拒绝', () => {
  const { service } = setupWorld();
  createResourceForTests(service);
  assert.throws(
    () => service.declareContribution(T11, { versionId: 'RES-1-V1', teacherRef: 'T-11', kind: 'authoring', weightSuggestion: 1.5 }),
    ValidationError
  );
});

test('重启恢复：用同一事件日志重建服务，版本图与冻结状态保持不变', () => {
  const log = new EventLog(null);
  const service1 = new NegotiationService(log);
  service1.bootstrapFacilitator({ schoolId: 'S1', schoolName: '一中', userId: 'F-1', displayName: '主持' });
  service1.createResource({ userId: 'F-1' }, { resourceId: 'R', title: 't', schoolId: 'S1', requiredConfirmations: 2 });
  service1.declareContribution({ userId: 'F-1' }, { versionId: 'R-V1', teacherRef: 'F-1', kind: 'coordination', weightSuggestion: 0.2 });
  // 需要第二位参与者才能演示冻结：登记一名教师
  service1.registerUser({ userId: 'F-1' }, { userId: 'T-1', displayName: '教师', schoolId: 'S1', role: 'teacher' });
  service1.declareContribution({ userId: 'F-1' }, { versionId: 'R-V1', teacherRef: 'T-1', kind: 'review', weightSuggestion: 0.2 });
  service1.confirm({ userId: 'F-1' }, { versionId: 'R-V1', decision: 'agreed' });
  service1.confirm({ userId: 'T-1' }, { versionId: 'R-V1', decision: 'agreed' });
  service1.createVersion({ userId: 'F-1' }, { resourceId: 'R', versionId: 'R-V2', parentVersionId: 'R-V1', requiredConfirmations: 2 });
  service1.raiseDispute({ userId: 'T-1' }, { versionId: 'R-V2', focus: 'f', basis: 'b' });

  // 模拟重启：新建投影与服务实例
  const service2 = new NegotiationService(log);
  const graph = service2.getVersionGraph({ userId: 'F-1' }, 'R');
  const byId = Object.fromEntries(graph.versions.map((v) => [v.versionId, v]));
  assert.equal(byId['R-V1'].state, 'working');
  assert.equal(byId['R-V2'].state, 'frozen');
  assert.equal(byId['R-V2'].parentVersionId, 'R-V1');

  // V2 继承贡献恢复
  const v2 = service2.getVersionDetail({ userId: 'F-1' }, 'R-V2');
  assert.equal(v2.contributions.length, 2);
  assert.ok(v2.contributions.every((c) => c.inherited));

  // 未决异议仍然阻止授权
  assert.throws(() => service2.authorize({ userId: 'F-1' }, { versionId: 'R-V2' }), ConflictError);
});

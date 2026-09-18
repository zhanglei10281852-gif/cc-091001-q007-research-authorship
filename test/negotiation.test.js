import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { HttpError } from '../src/errors.js';

async function bootstrap() {
  const service = new NegotiationService({ log: new EventLog(null) });
  await service.registerTeacher(null, { teacherRef: 'H1', name: '主持人', schoolId: 'S-A', role: 'host' });
  await service.registerTeacher('H1', { teacherRef: 'T1', name: '王老师', schoolId: 'S-A' });
  await service.registerTeacher('H1', { teacherRef: 'T2', name: '李老师', schoolId: 'S-B' });
  await service.registerTeacher('H1', { teacherRef: 'T3', name: '赵老师', schoolId: 'S-B' });
  await service.registerResource('H1', {
    resourceId: 'R1',
    title: '单元教学设计',
    schoolId: 'S-A',
    confidentialityNote: '内部评审意见，限主持人与协调员',
  });
  return service;
}

const errCode = (p) =>
  p.then(
    () => { throw new Error('应当拒绝'); },
    (e) => {
      assert.ok(e instanceof HttpError);
      return e.code;
    },
  );

test('完整流程：申报—共同确认—授权—签发发布摘要', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 2 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.6, basis: '主笔撰写' });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.3 });
  await s.claimContribution('T3', { resourceId: 'R1', versionId: 'V1', kind: 'classroom-validation', weightSuggestion: 0.4 });

  let view = s.viewVersion('T1', 'R1', 'V1');
  // 署名顺序：聚合权重降序，并列按申报先后。
  assert.deepEqual(view.authorshipOrder.map((o) => o.teacherRef), ['T1', 'T3', 'T2']);
  assert.deepEqual(view.confirmations.unconfirmed, ['T1', 'T2', 'T3']);
  assert.equal(view.confirmations.reached, false);

  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  // 重复确认幂等，不增加计数。
  assert.deepEqual(await s.agree('T1', { resourceId: 'R1', versionId: 'V1' }), { idempotent: true });
  await s.agree('T2', { resourceId: 'R1', versionId: 'V1' });

  view = s.viewVersion('T1', 'R1', 'V1');
  assert.equal(view.confirmations.count, 2);
  assert.deepEqual(view.confirmations.unconfirmed, ['T3']);
  assert.equal(view.confirmations.reached, true);

  const auth = await s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V1' });
  assert.equal(auth.type, 'VersionAuthorized');
  assert.match(auth.digest, /^[0-9a-f]{64}$/);

  const pub = await s.publishVersion('H1', { resourceId: 'R1', versionId: 'V1', notes: '秋季版' });
  assert.equal(pub.releaseSummary.authorshipOrder.map((o) => o.teacherRef).join(','), 'T1,T3,T2');
  assert.equal(s.viewVersion('T1', 'R1', 'V1').state, 'published');
});

test('未达到约定确认范围不能授权', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 3 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.5 });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.2 });
  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  assert.equal(await errCode(s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V1' })), 'CONFIRMATIONS_INSUFFICIENT');
});

test('有依据异议冻结版本，且不影响其他分支', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 2 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.6 });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.3 });
  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  await s.agree('T2', { resourceId: 'R1', versionId: 'V1' });

  // 无依据的异议被拒绝，不会冻结。
  assert.equal(await errCode(s.raiseDispute('T2', { resourceId: 'R1', versionId: 'V1', basis: '   ' })), 'BASIS_REQUIRED');

  await s.raiseDispute('T2', { resourceId: 'R1', versionId: 'V1', basis: '评审贡献被低估', focus: 'weight-allocation' });
  assert.equal(s.viewVersion('T1', 'R1', 'V1').state, 'frozen');
  // 冻结期间不能授权，也不能继续申报/确认。
  assert.equal(await errCode(s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V1' })), 'VERSION_FROZEN');
  assert.equal(await errCode(s.agree('T1', { resourceId: 'R1', versionId: 'V1' })), 'VERSION_FROZEN');

  // 争议焦点在版本视图中可见。
  const view = s.viewVersion('T1', 'R1', 'V1');
  assert.equal(view.disputes.open[0].focus, 'weight-allocation');
  assert.deepEqual(view.confirmations.objected, ['T2']);

  // 同一资源的另一分支（V2）不受影响，仍可协商。
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V9', requiredConfirmations: 1 });
  await s.claimContribution('T3', { resourceId: 'R1', versionId: 'V9', kind: 'coordination', weightSuggestion: 0.2 });
  await s.agree('T3', { resourceId: 'R1', versionId: 'V9' });
  const auth9 = await s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V9' });
  assert.equal(auth9.type, 'VersionAuthorized');

  const graph = s.versionGraph('T1', 'R1');
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.versionId, n]));
  assert.equal(byId.V1.frozen, true);
  assert.equal(byId.V9.frozen, false);

  // 主持人回应并裁定，异议解决后解除冻结；提出者需重新确认。
  await s.respondDispute('H1', { disputeKey: 'V1-d1', response: '已核对评审记录，调整为 0.4' });
  await s.resolveDispute('H1', { disputeKey: 'V1-d1', outcome: '权重调整，重新确认' });
  assert.equal(s.viewVersion('T1', 'R1', 'V1').state, 'working');
  assert.equal(s.viewVersion('T1', 'R1', 'V1').confirmations.count, 1); // T2 的同意随异议清除
});

test('撤回异议也可解除冻结', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.5 });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.2 });
  await s.raiseDispute('T2', { resourceId: 'R1', versionId: 'V1', basis: '有异议' });
  assert.equal(s.viewVersion('T1', 'R1', 'V1').frozen, true);
  await s.withdrawDispute('T2', { disputeKey: 'V1-d1' });
  assert.equal(s.viewVersion('T1', 'R1', 'V1').frozen, false);
});

test('撤回贡献不删除曾参与旧版本的事实', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.6 });
  const c2 = await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.3 });
  await s.withdrawContribution('T2', { resourceId: 'R1', versionId: 'V1', contributionId: c2.contributionId });

  const view = s.viewVersion('T1', 'R1', 'V1');
  assert.deepEqual(view.authorshipOrder.map((o) => o.teacherRef), ['T1']);
  assert.equal(view.withdrawnContributions.length, 1);
  assert.equal(view.withdrawnContributions[0].teacherRef, 'T2');
  assert.ok(view.withdrawnContributions[0].withdrawnAt);
  // 历史事件仍保留申报与撤回两条记录。
  const history = s.versionHistory('T1', 'R1', 'V1');
  const types = history.events.map((e) => e.type);
  assert.ok(types.includes('ContributionClaimed'));
  assert.ok(types.includes('ContributionWithdrawn'));
  // 不能撤回已撤回的记录。
  assert.equal(
    await errCode(s.withdrawContribution('T2', { resourceId: 'R1', versionId: 'V1', contributionId: c2.contributionId })),
    'CONTRIBUTION_NOT_FOUND',
  );
});

test('新版本继承已确认贡献，但分叉后分别协商', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 2 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.6 });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.3 });
  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  await s.agree('T2', { resourceId: 'R1', versionId: 'V1' });
  await s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V1' });
  await s.publishVersion('H1', { resourceId: 'R1', versionId: 'V1' });

  // V2 从已发布的 V1 分叉：继承两位已确认教师的贡献。
  await s.createVersion('H1', {
    resourceId: 'R1',
    versionId: 'V2',
    parentVersionId: 'V1',
    branchReason: '增加课堂验证章节',
  });
  const v2 = s.viewVersion('T1', 'R1', 'V2');
  assert.equal(v2.contributions.length, 2);
  assert.ok(v2.contributions.every((c) => c.inheritedFrom));
  // 确认不带入：分叉后必须重新协商。
  assert.equal(v2.confirmations.count, 0);
  assert.deepEqual(v2.confirmations.unconfirmed, ['T1', 'T2']);

  // 在 V2 申报新贡献不影响 V1 的已发布摘要。
  await s.claimContribution('T3', { resourceId: 'R1', versionId: 'V2', kind: 'classroom-validation', weightSuggestion: 0.5 });
  const v1 = s.viewVersion('T1', 'R1', 'V1');
  assert.equal(v1.state, 'published');
  assert.deepEqual(v1.publication.releaseSummary.authorshipOrder.map((o) => o.teacherRef), ['T1', 'T2']);
  assert.deepEqual(s.viewVersion('T1', 'R1', 'V2').authorshipOrder.map((o) => o.teacherRef), ['T1', 'T3', 'T2']);

  // 未确认者的贡献不继承：T3 只在 V2 协商；若其未确认 V2，则再次分叉 V3 时不带入。
  await s.agree('T1', { resourceId: 'R1', versionId: 'V2' });
  await s.agree('T2', { resourceId: 'R1', versionId: 'V2' });
  // T3 未确认 V2
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V3', parentVersionId: 'V2' });
  const v3 = s.viewVersion('T1', 'R1', 'V3');
  assert.deepEqual(v3.contributions.map((c) => c.teacherRef).sort(), ['T1', 'T2']);
});

test('证据链可还原署名顺序的形成过程', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.claimContribution('T2', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.9 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.9 });
  const history = s.versionHistory('T1', 'R1', 'V1');
  // 同权重并列时先申报者在前，且顺序可由事件序列解释。
  assert.deepEqual(history.currentAuthorshipOrder.map((o) => o.teacherRef), ['T2', 'T1']);
  const claimEvents = history.events.filter((e) => e.type === 'ContributionClaimed');
  assert.equal(claimEvents[0].teacherRef, 'T2');
  assert.equal(claimEvents[1].teacherRef, 'T1');
});

test('权限：保密说明仅主持人/协调员可读，普通教师 403', async () => {
  const s = await bootstrap();
  // 主持人可读取。
  const hostView = s.viewResource('H1', 'R1', { includeConfidential: true });
  assert.match(hostView.view.confidentialityNote, /内部评审/);
  // 普通教师显式请求 → 403。
  assert.equal(
    await errCode(Promise.resolve().then(() => s.viewResource('T1', 'R1', { includeConfidential: true }))),
    'CONFIDENTIAL_DENIED',
  );
  // 普通教师普通视图不包含该字段。
  const teacherView = s.viewResource('T1', 'R1').view;
  assert.equal(teacherView.confidentialityNote, undefined);
  // 未登记身份被拒。
  assert.equal(await errCode(Promise.resolve().then(() => s.viewResource('NX', 'R1'))), 'UNAUTHENTICATED');
  // 普通教师不能登记资源或授权。
  assert.equal(await errCode(s.registerResource('T1', { resourceId: 'R2', title: 'x', schoolId: 'S-A' })), 'RESOURCE_REGISTER_DENIED');
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.5 });
  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  assert.equal(await errCode(s.authorizeVersion('T1', { resourceId: 'R1', versionId: 'V1' })), 'HOST_ONLY');
});

test('发布后不可改写，只能分叉', async () => {
  const s = await bootstrap();
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.5 });
  await s.agree('T1', { resourceId: 'R1', versionId: 'V1' });
  await s.authorizeVersion('H1', { resourceId: 'R1', versionId: 'V1' });
  await s.publishVersion('H1', { resourceId: 'R1', versionId: 'V1' });
  assert.equal(await errCode(s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'review', weightSuggestion: 0.1 })), 'VERSION_LOCKED');
  assert.equal(await errCode(s.raiseDispute('T1', { resourceId: 'R1', versionId: 'V1', basis: 'x' })), 'VERSION_LOCKED');
  assert.equal(await errCode(s.publishVersion('H1', { resourceId: 'R1', versionId: 'V1' })), 'VERSION_PUBLISHED');
});

test('重启重放：版本图与冻结状态保持不变', async () => {
  const log = new EventLog(null);
  let s = new NegotiationService({ log });
  await s.registerTeacher(null, { teacherRef: 'H1', name: '主持人', schoolId: 'S-A', role: 'host' });
  await s.registerTeacher('H1', { teacherRef: 'T1', name: '王老师', schoolId: 'S-A' });
  await s.registerResource('H1', { resourceId: 'R1', title: 't', schoolId: 'S-A', confidentialityNote: '密' });
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V1', requiredConfirmations: 1 });
  await s.createVersion('H1', { resourceId: 'R1', versionId: 'V2', parentVersionId: 'V1' });
  await s.claimContribution('T1', { resourceId: 'R1', versionId: 'V1', kind: 'authoring', weightSuggestion: 0.5 });
  await s.raiseDispute('T1', { resourceId: 'R1', versionId: 'V1', basis: '冻结证据' });

  // 用同一事件日志重新构建服务，等价于重启。
  const restarted = new NegotiationService({ log });
  assert.equal(restarted.viewVersion('T1', 'R1', 'V1').state, 'frozen');
  assert.equal(restarted.viewVersion('T1', 'R1', 'V2').state, 'working');
  assert.equal(restarted.viewResource('H1', 'R1', { includeConfidential: true }).view.confidentialityNote, '密');
  const graph = restarted.versionGraph('T1', 'R1');
  assert.deepEqual(graph.nodes.map((n) => [n.versionId, n.parentVersionId, n.state]), [
    ['V1', null, 'frozen'],
    ['V2', 'V1', 'working'],
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHttp, call } from './helpers.js';

let env;
test.before(async () => {
  env = await startHttp();
});
test.after(async () => {
  await env.close();
});

test('HTTP：无凭证返回 401', async () => {
  const res = await fetch(`${env.base}/resources/RES-x`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /凭证/);
});

test('HTTP：Bearer 令牌认证生效，无效令牌 401', async () => {
  // 主持人生成本人令牌
  const issued = await call(env.base, 'POST', '/admin/tokens', {
    user: 'F-1',
    body: { userId: 'T-11' },
  });
  assert.equal(issued.status, 200);
  const { token } = await issued.json();

  const ok = await call(env.base, 'GET', '/versions/NOPE', { token });
  assert.equal(ok.status, 404);

  const bad = await call(env.base, 'GET', '/versions/NOPE', { token: 'forged' });
  assert.equal(bad.status, 401);
});

test('HTTP：教师不能签发令牌（403）', async () => {
  const res = await call(env.base, 'POST', '/admin/tokens', { user: 'T-11', body: { userId: 'T-12' } });
  assert.equal(res.status, 403);
});

test('HTTP：保密说明对教师缺省、对主持人返回', async () => {
  await call(env.base, 'POST', '/resources', {
    user: 'F-1',
    body: { resourceId: 'RH', title: '保密资源', schoolId: 'S1', confidentialNote: '机密内容', requiredConfirmations: 2 },
  });
  const teacher = await call(env.base, 'GET', '/resources/RH', { user: 'T-11' });
  assert.equal(teacher.status, 200);
  const teacherBody = await teacher.json();
  assert.equal('confidentialNote' in teacherBody, false);

  const fac = await call(env.base, 'GET', '/resources/RH', { user: 'F-1' });
  const facBody = await fac.json();
  assert.equal(facBody.confidentialNote, '机密内容');
});

test('HTTP：端到端走完申报→确认→冻结隔离→授权→发布', async () => {
  // 建资源
  let res = await call(env.base, 'POST', '/resources', {
    user: 'F-1',
    body: { resourceId: 'RE', title: '端到端资源', schoolId: 'S1', requiredConfirmations: 2 },
  });
  assert.equal(res.status, 200);

  // 两位教师申报
  for (const [user, kind, w] of [
    ['T-11', 'authoring', 0.6],
    ['T-12', 'classroom-validation', 0.25],
  ]) {
    res = await call(env.base, 'POST', '/versions/RE-V1/contributions', {
      user,
      body: { teacherRef: user, kind, weightSuggestion: w },
    });
    assert.equal(res.status, 200);
  }

  // T-21 非参与者不能确认
  res = await call(env.base, 'POST', '/versions/RE-V1/confirmations', {
    user: 'T-21',
    body: { decision: 'agreed' },
  });
  assert.equal(res.status, 403);

  // 两人确认
  for (const user of ['T-11', 'T-12']) {
    res = await call(env.base, 'POST', '/versions/RE-V1/confirmations', { user, body: { decision: 'agreed' } });
    assert.equal(res.status, 200);
  }

  // 分叉 V2，随后在 V2 提异议，验证只冻结 V2
  res = await call(env.base, 'POST', '/resources/RE/versions', {
    user: 'F-1',
    body: { versionId: 'RE-V2', parentVersionId: 'RE-V1', requiredConfirmations: 2, branchReason: '修订' },
  });
  assert.equal(res.status, 200);

  res = await call(env.base, 'POST', '/versions/RE-V2/disputes', {
    user: 'T-11',
    body: { focus: '继承争议', basis: '课堂验证记录需补充' },
  });
  assert.equal(res.status, 200);

  const graphRes = await call(env.base, 'GET', '/resources/RE/graph', { user: 'F-1' });
  const graph = await graphRes.json();
  const byId = Object.fromEntries(graph.versions.map((v) => [v.versionId, v]));
  assert.equal(byId['RE-V2'].state, 'frozen');
  assert.equal(byId['RE-V1'].state, 'working');

  // V1 授权并发布
  res = await call(env.base, 'POST', '/versions/RE-V1/authorize', { user: 'F-1' });
  assert.equal(res.status, 200);
  res = await call(env.base, 'POST', '/versions/RE-V1/publish', { user: 'F-1' });
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.deepEqual(summary.authorship.map((a) => a.teacherRef), ['T-11', 'T-12']);
  assert.equal(summary.authorship[0].schoolId, 'S1');

  // 署名轨迹可还原
  const trailRes = await call(env.base, 'GET', '/versions/RE-V1/authorship', { user: 'F-1' });
  const trail = await trailRes.json();
  assert.equal(trail.trail.length, 2);
  assert.match(trail.trail[0].basis, /权重/);
});

test('HTTP：未达确认范围授权返回 409 且说明未确认者', async () => {
  await call(env.base, 'POST', '/resources', {
    user: 'F-1',
    body: { resourceId: 'RU', title: '不足范围', schoolId: 'S1', requiredConfirmations: 2 },
  });
  await call(env.base, 'POST', '/versions/RU-V1/contributions', {
    user: 'F-1',
    body: { teacherRef: 'T-11', kind: 'authoring', weightSuggestion: 0.5 },
  });
  await call(env.base, 'POST', '/versions/RU-V1/confirmations', { user: 'T-11', body: { decision: 'agreed' } });

  const res = await call(env.base, 'POST', '/versions/RU-V1/authorize', { user: 'F-1' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /确认范围不足/);
});

test('HTTP：非法 JSON 返回 400，未知路由 404', async () => {
  const res = await fetch(`${env.base}/resources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-user': 'F-1' },
    body: '{不是json',
  });
  assert.equal(res.status, 400);
  const res404 = await call(env.base, 'GET', '/no/such/route', { user: 'F-1' });
  assert.equal(res404.status, 404);
});

test('HTTP：健康检查无需认证', async () => {
  const res = await fetch(`${env.base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

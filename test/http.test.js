import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { createApp } from '../src/server.js';

class TestClient {
  constructor(base) {
    this.base = base;
  }
  async request(method, path, { actor = null, body = undefined } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'x-teacher-ref': actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
}

async function startServer(dir) {
  const log = new EventLog(join(dir, 'events.jsonl'));
  await log.load();
  const service = new NegotiationService({ log });
  const server = createServer(createApp(service));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, client: new TestClient(`http://127.0.0.1:${port}`), log, service };
}

test('HTTP 端到端协商流程 + 文件持久化重启', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'negotiation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let ctx = await startServer(dir);
  const { client } = ctx;

  let r = await client.request('POST', '/teachers', { body: { teacherRef: 'H1', name: '主持人', schoolId: 'S-A', role: 'host' } });
  assert.equal(r.status, 201);
  r = await client.request('POST', '/teachers', { actor: 'H1', body: { teacherRef: 'T1', name: '王老师', schoolId: 'S-A' } });
  assert.equal(r.status, 201);
  r = await client.request('POST', '/teachers', { actor: 'H1', body: { teacherRef: 'T2', name: '李老师', schoolId: 'S-B' } });
  assert.equal(r.status, 201);

  r = await client.request('POST', '/resources', { actor: 'H1', body: { resourceId: 'R1', title: '课程', schoolId: 'S-A', confidentialityNote: '保密' } });
  assert.equal(r.status, 201);

  assert.equal((await client.request('POST', '/resources', { actor: 'T1', body: { resourceId: 'R2', title: 'x', schoolId: 'S-A' } })).status, 403);

  r = await client.request('POST', '/resources/R1/versions', { actor: 'H1', body: { versionId: 'V1', requiredConfirmations: 2 } });
  assert.equal(r.status, 201);

  assert.equal((await client.request('POST', '/resources/R1/versions/V1/contributions', { body: { kind: 'authoring', weightSuggestion: 0.5 } })).status, 401);

  assert.equal((await client.request('POST', '/resources/R1/versions/V1/contributions', { actor: 'T1', body: { kind: 'authoring', weightSuggestion: 0.6 } })).status, 201);
  assert.equal((await client.request('POST', '/resources/R1/versions/V1/contributions', { actor: 'T2', body: { kind: 'review', weightSuggestion: 0.3 } })).status, 201);
  assert.equal((await client.request('POST', '/resources/R1/versions/V1/confirmations', { actor: 'T1' })).status, 201);
  // 重复确认返回 200 duplicated，计数不变。
  r = await client.request('POST', '/resources/R1/versions/V1/confirmations', { actor: 'T1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.duplicated, true);
  assert.equal((await client.request('POST', '/resources/R1/versions/V1/confirmations', { actor: 'T2' })).status, 201);

  // 保密说明越权 403。
  assert.equal((await client.request('GET', '/resources/R1?confidential=true', { actor: 'T2' })).status, 403);
  assert.equal((await client.request('GET', '/resources/R1?confidential=true', { actor: 'H1' })).status, 200);

  assert.equal((await client.request('POST', '/resources/R1/versions/V1/authorization', { actor: 'H1' })).status, 201);
  assert.equal((await client.request('POST', '/resources/R1/versions/V1/publication', { actor: 'H1', body: { notes: '首发' } })).status, 201);

  r = await client.request('GET', '/resources/R1/versions/V1/history', { actor: 'T1' });
  assert.equal(r.status, 200);
  assert.ok(r.json.events.length >= 6);

  // 分叉后冻结不影响其他分支。
  await client.request('POST', '/resources/R1/versions', { actor: 'H1', body: { versionId: 'V2', parentVersionId: 'V1' } });
  await client.request('POST', '/resources/R1/versions/V2/disputes', { actor: 'T2', body: { basis: '新章节署名需再议' } });
  r = await client.request('GET', '/resources/R1/versions/V2', { actor: 'T1' });
  assert.equal(r.json.state, 'frozen');
  r = await client.request('GET', '/resources/R1/versions/V1/graph', { actor: 'T1' });
  assert.deepEqual(r.json.nodes.map((n) => [n.versionId, n.state]), [['V1', 'published'], ['V2', 'frozen']]);

  ctx.server.closeAllConnections(); await new Promise((resolve) => ctx.server.close(resolve));

  // 重启：从 JSONL 事件日志重放，冻结与发布状态保持不变。
  ctx = await startServer(dir);
  r = await ctx.client.request('GET', '/resources/R1/versions/V2', { actor: 'T1' });
  assert.equal(r.json.state, 'frozen');
  assert.equal(r.json.disputes.open.length, 1);
  r = await ctx.client.request('GET', '/resources/R1/versions/V1', { actor: 'T1' });
  assert.equal(r.json.state, 'published');
  assert.ok(r.json.publication.releaseSummary.snapshotDigest);
  ctx.server.closeAllConnections(); await new Promise((resolve) => ctx.server.close(resolve));
});

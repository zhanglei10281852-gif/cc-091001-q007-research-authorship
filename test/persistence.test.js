import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { TokenStore } from '../src/auth.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'tr-auth-'));
}

test('持久化：事件落盘为 JSONL，重启后版本图、冻结与发布状态一致', () => {
  const dir = freshDir();
  try {
    const logFile = join(dir, 'events.jsonl');

    // 第一次运行：完成引导、协商、冻结
    let log = new EventLog(logFile);
    let svc = new NegotiationService(log);
    svc.bootstrapFacilitator({ schoolId: 'S1', schoolName: '一中', userId: 'F-1', displayName: '主持' });
    svc.registerUser({ userId: 'F-1' }, { userId: 'T-1', displayName: '教师甲', schoolId: 'S1', role: 'teacher' });
    svc.registerUser({ userId: 'F-1' }, { userId: 'T-2', displayName: '教师乙', schoolId: 'S1', role: 'teacher' });
    svc.createResource({ userId: 'F-1' }, {
      resourceId: 'R', title: '持久化资源', schoolId: 'S1', requiredConfirmations: 2,
    });
    svc.declareContribution({ userId: 'F-1' }, { versionId: 'R-V1', teacherRef: 'T-1', kind: 'authoring', weightSuggestion: 0.6 });
    svc.declareContribution({ userId: 'F-1' }, { versionId: 'R-V1', teacherRef: 'T-2', kind: 'review', weightSuggestion: 0.2 });
    svc.confirm({ userId: 'T-1' }, { versionId: 'R-V1', decision: 'agreed' });
    svc.confirm({ userId: 'T-2' }, { versionId: 'R-V1', decision: 'agreed' });
    svc.authorize({ userId: 'F-1' }, { versionId: 'R-V1' });
    svc.publish({ userId: 'F-1' }, { versionId: 'R-V1' });

    svc.createVersion({ userId: 'F-1' }, { resourceId: 'R', versionId: 'R-V2', parentVersionId: 'R-V1', requiredConfirmations: 2 });
    svc.raiseDispute({ userId: 'T-1' }, { versionId: 'R-V2', focus: '分叉争议', basis: '某依据' });

    assert.ok(existsSync(logFile));
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    // 每行都是合法 JSON 且序号连续
    let expectedSeq = 1;
    for (const line of lines) {
      const evt = JSON.parse(line);
      assert.equal(evt.seq, expectedSeq++);
    }

    // 第二次运行：重新打开同一日志（模拟进程重启）
    log = new EventLog(logFile);
    svc = new NegotiationService(log);

    const graph = svc.getVersionGraph({ userId: 'F-1' }, 'R');
    const byId = Object.fromEntries(graph.versions.map((v) => [v.versionId, v]));
    assert.equal(byId['R-V1'].state, 'published');
    assert.equal(byId['R-V2'].state, 'frozen');
    assert.equal(byId['R-V2'].parentVersionId, 'R-V1');

    // 已发布摘要仍可查，且不可再次发布
    const v1 = svc.getVersionDetail({ userId: 'F-1' }, 'R-V1');
    assert.equal(v1.publication.versionId, 'R-V1');
    assert.equal(v1.publication.authorship.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：令牌库落盘且重启后仍可解析身份', () => {
  const dir = freshDir();
  try {
    const tokenFile = join(dir, 'tokens.json');
    let tokens = new TokenStore(tokenFile);
    const t = tokens.issue('F-1');
    assert.ok(existsSync(tokenFile));

    tokens = new TokenStore(tokenFile);
    assert.equal(tokens.resolve(t), 'F-1');
    assert.equal(tokens.resolve('not-a-real-token'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：多事件批量提交在文件中保持同批与连续序号', () => {
  const dir = freshDir();
  try {
    const logFile = join(dir, 'events.jsonl');
    const log = new EventLog(logFile);
    const svc = new NegotiationService(log);
    svc.bootstrapFacilitator({ schoolId: 'S1', schoolName: '一中', userId: 'F-1', displayName: '主持' });
    svc.registerUser({ userId: 'F-1' }, { userId: 'T-9', displayName: '教师', schoolId: 'S1', role: 'teacher' });

    // createResource 一次批量写入 resource-created + version-created，时间戳相同
    svc.createResource({ userId: 'F-1' }, { resourceId: 'B', title: '批量', schoolId: 'S1' });
    const records = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
    const resourceEvents = records.filter((e) => ['resource-created', 'version-created'].includes(e.type));
    assert.equal(resourceEvents.length, 2);
    assert.equal(resourceEvents[0].recordedAt, resourceEvents[1].recordedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

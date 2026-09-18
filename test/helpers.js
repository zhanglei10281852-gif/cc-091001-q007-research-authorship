import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { TokenStore } from '../src/auth.js';
import { createServer } from '../src/server.js';

/**
 * 建立一套内存中的协商环境：
 *   S1（第一中学）、S2（第二中学）
 *   F-1 主持人（S1），C-1 统筹人（S1），C-2 统筹人（S2）
 *   T-11、T-12 教师（S1），T-21 教师（S2）
 */
export function setupWorld() {
  const log = new EventLog(null);
  const service = new NegotiationService(log);

  service.bootstrapFacilitator({
    schoolId: 'S1',
    schoolName: '第一中学',
    userId: 'F-1',
    displayName: '主持人方老师',
  });

  service.registerSchool({ userId: 'F-1' }, { schoolId: 'S2', name: '第二中学' });
  service.registerUser(
    { userId: 'F-1' },
    { userId: 'C-1', displayName: '一中统筹陈老师', schoolId: 'S1', role: 'coordination' }
  );
  service.registerUser(
    { userId: 'F-1' },
    { userId: 'C-2', displayName: '二中统筹赵老师', schoolId: 'S2', role: 'coordination' }
  );
  service.registerUser(
    { userId: 'F-1' },
    { userId: 'T-11', displayName: '王老师', schoolId: 'S1', role: 'teacher' }
  );
  service.registerUser(
    { userId: 'F-1' },
    { userId: 'T-12', displayName: '李老师', schoolId: 'S1', role: 'teacher' }
  );
  service.registerUser(
    { userId: 'F-1' },
    { userId: 'T-21', displayName: '孙老师', schoolId: 'S2', role: 'teacher' }
  );

  return { log, service };
}

export function startHttp() {
  const { log, service } = setupWorld();
  const tokens = new TokenStore(null);
  const server = createServer({ service, tokens });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        log,
        service,
        tokens,
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

// 以某身份发起请求（非生产环境使用 X-Dev-User 测试头）
export function call(base, method, path, { user, token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (user) headers['x-dev-user'] = user;
  return fetch(new URL(path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

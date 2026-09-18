import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AuthError } from './errors.js';

/**
 * 持有者令牌（Bearer token）-> 已登记教师编号 的映射表。
 * 令牌文件独立于事件日志存放，须置于具备访问控制的运行环境；
 * 这里给出最小可用实现，生产部署应替换为受控的密钥管理。
 */
export class TokenStore {
  constructor(file) {
    this.file = file;
    this.tokens = new Map();
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const [token, userId] of Object.entries(raw)) this.tokens.set(token, userId);
    }
  }

  issue(userId, token = randomUUID()) {
    this.tokens.set(token, userId);
    this.#persist();
    return token;
  }

  resolve(token) {
    return this.tokens.get(token) ?? null;
  }

  #persist() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.tokens), null, 2));
    renameSync(tmp, this.file);
  }

  /**
   * 从请求中解析操作者身份。
   * 生产模式（NODE_ENV=production）只接受 Bearer 令牌；
   * 其他环境额外放行 X-Dev-User 头，便于本地与自动化测试。
   */
  authenticate(req) {
    const devUser = req.headers['x-dev-user'];
    if (devUser && process.env.NODE_ENV !== 'production') {
      return { userId: String(devUser) };
    }
    const header = req.headers['authorization'] || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) throw new AuthError();
    const userId = this.resolve(match[1].trim());
    if (!userId) throw new AuthError('令牌无效或已失效');
    return { userId };
  }
}

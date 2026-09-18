import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
/**
 * 只追加事件日志。所有状态变更先落盘为不可变事件，再投影到内存状态；
 * 服务重启后重放日志即可完整还原版本图、确认记录与冻结状态。
 */
export class EventLog {
  constructor(filePath) {
    this.filePath = filePath || null;
    this.events = [];
    this.#chain = Promise.resolve();
  }

  #chain;

  async load() {
    if (!this.filePath || !existsSync(this.filePath)) return this.events;
    const raw = await fs.readFile(this.filePath, 'utf8');
    this.events = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return this.events;
  }

  /** 串行化追加，保证事件顺序与调用顺序一致。 */
  append(type, payload = {}) {
    const task = this.#chain.then(async () => {
      const event = {
        eventId: this.events.length + 1,
        type,
        timestamp: new Date().toISOString(),
        ...payload,
      };
      if (this.filePath) {
        await fs.appendFile(this.filePath, JSON.stringify(event) + '\n');
      }
      this.events.push(event);
      return event;
    });
    // 后续追加必须等待本次完成。
    this.#chain = task.catch(() => {});
    return task;
  }
}

export function digestSnapshot(snapshot) {
  return createHash('sha256').update(snapshot).digest('hex');
}

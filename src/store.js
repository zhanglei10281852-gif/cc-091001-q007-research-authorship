import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 只追加（append-only）的事件日志。
 *
 * 所有协商事实——贡献申报、立场确认、异议、撤回、授权、发布——都以事件
 * 形式追加到 JSONL 文件。状态只能由事件重放得到，因此：
 *   - 证据连续且不可悄悄改写（撤回也只是新增一个撤回事件）；
 *   - 服务重启后重放日志即可还原完整版本图、冻结状态与发布摘要。
 *
 * file 为 null 时进入纯内存模式，供单元测试使用。
 */
export class EventLog {
  constructor(file = null) {
    this.file = file;
    this.events = [];
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.events.push(JSON.parse(trimmed));
        }
      }
    }
  }

  get length() {
    return this.events.length;
  }

  append(type, payload = {}) {
    return this.appendBatch([{ type, payload }])[0];
  }

  // 一批事件在单次磁盘写入中落盘，避免“继承父版本”这类多事件动作半途崩溃
  appendBatch(items) {
    const baseSeq = this.events.length;
    const recordedAt = new Date().toISOString();
    const records = items.map((item, index) => ({
      seq: baseSeq + index + 1,
      recordedAt,
      type: item.type,
      payload: item.payload,
    }));
    if (this.file) {
      appendFileSync(this.file, records.map((e) => JSON.stringify(e)).join('\n') + '\n', {
        flag: 'a',
      });
    }
    this.events.push(...records);
    return records;
  }

  [Symbol.iterator]() {
    return this.events[Symbol.iterator]();
  }
}

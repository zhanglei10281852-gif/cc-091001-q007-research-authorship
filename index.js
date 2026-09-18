import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventLog } from './src/store.js';
import { NegotiationService } from './src/service.js';
import { TokenStore } from './src/auth.js';
import { createServer } from './src/server.js';

/**
 * 服务入口。
 *
 * 数据全部落在 --data 目录（默认 ./data）：
 *   events.jsonl  只追加的协商证据事件日志（版本图与冻结状态的唯一事实来源）
 *   tokens.json   持有者令牌映射（须置于具备访问控制的运行环境）
 *
 * 启动时重放事件日志，版本图、确认、异议与冻结状态全部恢复。
 */
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg) => {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    return m ? [[m[1], m[2]]] : [];
  })
);

const dataDir = args.data || process.env.DATA_DIR || './data';
const port = Number(args.port || process.env.PORT || 3000);
mkdirSync(dataDir, { recursive: true });

const eventLog = new EventLog(`${dataDir}/events.jsonl`);
const tokenStore = new TokenStore(`${dataDir}/tokens.json`);
const service = new NegotiationService(eventLog);
const server = createServer({ service, tokens: tokenStore });

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: '教研署名协商服务已启动',
      port,
      dataDir,
      eventsReplayed: eventLog.length,
    })
  );
});

const shutdown = (signal) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: '收到退出信号，停止接收新请求', signal }));
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventLog } from '../src/store.js';
import { NegotiationService } from '../src/service.js';
import { createApp } from '../src/server.js';

const port = Number(process.env.PORT || 3000);
const logPath = process.env.EVENT_LOG || './data/events.jsonl';

await mkdir(dirname(logPath), { recursive: true });
const log = new EventLog(logPath);
await log.load();
const service = new NegotiationService({ log });
const server = createServer(createApp(service));

server.listen(port, () => {
  console.log(`署名协商服务已启动：http://localhost:${port}（事件日志 ${logPath}，已重放 ${log.events.length} 条事件）`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

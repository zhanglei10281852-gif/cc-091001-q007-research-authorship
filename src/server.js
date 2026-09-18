import { HttpError } from './errors.js';

const JSON_TYPES = new Set(['POST', 'PUT', 'PATCH']);

async function readJson(req) {
  if (!JSON_TYPES.has(req.method)) return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {import('./service.js').NegotiationService} service
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createApp(service) {
  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const actorRef = req.headers['x-teacher-ref'] || null;
    try {
      const body = await readJson(req);
      const m = req.method;

      if (m === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, events: service.log.events.length });
      }

      // POST /teachers —— 首个教师自动成为主持人（引导），其后需主持人登记。
      if (m === 'POST' && path === '/teachers') {
        const event = await service.registerTeacher(actorRef, body);
        return send(res, 201, event);
      }

      if (m === 'POST' && path === '/resources') {
        const event = await service.registerResource(actorRef, body);
        return send(res, 201, event);
      }

      let match = path.match(/^\/resources\/([^/]+)$/);
      if (m === 'GET' && match) {
        const result = service.viewResource(actorRef, match[1], {
          includeConfidential: url.searchParams.get('confidential') === 'true',
        });
        return send(res, 200, result.view);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions$/);
      if (m === 'POST' && match) {
        const event = await service.createVersion(actorRef, { resourceId: match[1], ...body });
        return send(res, 201, event);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)$/);
      if (m === 'GET' && match) {
        return send(res, 200, service.viewVersion(actorRef, match[1], match[2]));
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/graph$/);
      if (m === 'GET' && match) {
        return send(res, 200, service.versionGraph(actorRef, match[1]));
      }
      if (m === 'GET' && path === '/graph') {
        const resourceId = url.searchParams.get('resourceId');
        return send(res, 200, service.versionGraph(actorRef, resourceId));
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/history$/);
      if (m === 'GET' && match) {
        return send(res, 200, service.versionHistory(actorRef, match[1], match[2]));
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/contributions$/);
      if (m === 'POST' && match) {
        const event = await service.claimContribution(actorRef, {
          resourceId: match[1],
          versionId: match[2],
          ...body,
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/withdrawals$/);
      if (m === 'POST' && match) {
        const event = await service.withdrawContribution(actorRef, {
          resourceId: match[1],
          versionId: match[2],
          contributionId: body.contributionId,
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/confirmations$/);
      if (m === 'POST' && match) {
        const result = await service.agree(actorRef, { resourceId: match[1], versionId: match[2] });
        return send(res, result.idempotent ? 200 : 201, {
          ok: true,
          duplicated: result.idempotent,
        });
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/disputes$/);
      if (m === 'POST' && match) {
        const event = await service.raiseDispute(actorRef, {
          resourceId: match[1],
          versionId: match[2],
          basis: body.basis,
          focus: body.focus ?? null,
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/disputes\/([^/]+)\/responses$/);
      if (m === 'POST' && match) {
        const event = await service.respondDispute(actorRef, {
          disputeKey: match[1],
          response: body.response,
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/disputes\/([^/]+)\/resolutions$/);
      if (m === 'POST' && match) {
        const event = await service.resolveDispute(actorRef, {
          disputeKey: match[1],
          outcome: body.outcome,
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/disputes\/([^/]+)\/withdrawal$/);
      if (m === 'POST' && match) {
        const event = await service.withdrawDispute(actorRef, { disputeKey: match[1] });
        return send(res, 201, event);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/authorization$/);
      if (m === 'POST' && match) {
        const event = await service.authorizeVersion(actorRef, {
          resourceId: match[1],
          versionId: match[2],
        });
        return send(res, 201, event);
      }

      match = path.match(/^\/resources\/([^/]+)\/versions\/([^/]+)\/publication$/);
      if (m === 'POST' && match) {
        const event = await service.publishVersion(actorRef, {
          resourceId: match[1],
          versionId: match[2],
          notes: body.notes ?? null,
        });
        return send(res, 201, event);
      }

      send(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: `未找到路由：${m} ${path}` } });
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      }
      send(res, 500, { error: { code: 'INTERNAL', message: error.message } });
    }
  };
}

import http from 'node:http';
import { DomainError, ValidationError } from './errors.js';

const MAX_BODY_BYTES = 64 * 1024;

const json = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ValidationError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

/**
 * @param {{ service: import('./service.js').NegotiationService, tokens: import('./auth.js').TokenStore }} deps
 */
export function createServer({ service, tokens }) {
  // 路由：[method, regex, handler]
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`
    );
    routes.push({ method, re, keys, handler });
  };

  // 登记与令牌
  route('POST', '/admin/schools', async (actor, body) => service.registerSchool(actor, body));
  route('POST', '/admin/users', async (actor, body) => service.registerUser(actor, body));
  route('POST', '/admin/tokens', async (actor, body) => {
    // 只有主持人能签发令牌；令牌属于运营凭证，不进入协商证据日志
    if (!body.userId) throw new ValidationError('缺少 userId');
    service.assertFacilitator(actor);
    service.assertRegisteredUser(body.userId);
    const token = tokens.issue(body.userId);
    return { userId: body.userId, token, issuedBy: actor.userId };
  });

  // 资源
  route('POST', '/resources', async (actor, body) => service.createResource(actor, body));
  route('GET', '/resources/:rid', async (actor, _body, params) =>
    service.getResource(actor, params.rid)
  );
  route('GET', '/resources/:rid/graph', async (actor, _body, params) =>
    service.getVersionGraph(actor, params.rid)
  );

  // 版本
  route('POST', '/resources/:rid/versions', async (actor, body, params) =>
    service.createVersion(actor, { ...body, resourceId: params.rid })
  );
  route('GET', '/versions/:vid', async (actor, _body, params) =>
    service.getVersionDetail(actor, params.vid)
  );
  route('GET', '/versions/:vid/readiness', async (actor, _body, params) =>
    service.getVersionDetail(actor, params.vid).then((d) => d.readiness)
  );
  route('GET', '/versions/:vid/authorship', async (actor, _body, params) =>
    service.getAuthorshipTrail(actor, params.vid)
  );
  route('GET', '/versions/:vid/evidence', async (actor, _body, params) =>
    service.getEvidence(actor, params.vid)
  );

  // 贡献
  route('POST', '/versions/:vid/contributions', async (actor, body, params) =>
    service.declareContribution(actor, { ...body, versionId: params.vid })
  );
  route('POST', '/contributions/:cid/withdraw', async (actor, _body, params) =>
    service.withdrawContribution(actor, { contributionId: params.cid })
  );

  // 立场确认
  route('POST', '/versions/:vid/confirmations', async (actor, body, params) =>
    service.confirm(actor, { ...body, versionId: params.vid })
  );

  // 异议与冻结
  route('POST', '/versions/:vid/disputes', async (actor, body, params) =>
    service.raiseDispute(actor, { ...body, versionId: params.vid })
  );
  route('POST', '/disputes/:did/respond', async (actor, body, params) =>
    service.respondDispute(actor, { ...body, disputeId: params.did })
  );
  route('POST', '/disputes/:did/resolve', async (actor, body, params) =>
    service.resolveDispute(actor, { ...body, disputeId: params.did })
  );
  route('POST', '/disputes/:did/withdraw', async (actor, _body, params) =>
    service.withdrawDispute(actor, { disputeId: params.did })
  );
  route('POST', '/versions/:vid/unfreeze', async (actor, _body, params) =>
    service.unfreeze(actor, { versionId: params.vid })
  );

  // 署名顺序
  route('POST', '/versions/:vid/ordering', async (actor, body, params) =>
    service.decideOrdering(actor, { ...body, versionId: params.vid })
  );

  // 发布授权与发布
  route('POST', '/versions/:vid/authorize', async (actor, _body, params) =>
    service.authorize(actor, { versionId: params.vid })
  );
  route('POST', '/versions/:vid/publish', async (actor, _body, params) =>
    service.publish(actor, { versionId: params.vid })
  );

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      return json(res, 200, {
        service: 'teaching-research-authorship-negotiation',
        status: 'ok',
      });
    }

    // 系统引导：无需既有凭证，仅在系统尚无登记用户时成功
    if (req.method === 'POST' && path === '/admin/bootstrap') {
      try {
        const body = await readBody(req);
        const result = service.bootstrapFacilitator(body);
        return json(res, 200, { ok: true, events: result.length });
      } catch (err) {
        if (err instanceof DomainError) return json(res, err.httpStatus ?? 400, { error: err.message });
        return json(res, 500, { error: '服务内部错误' });
      }
    }

    let actor;
    try {
      actor = tokens.authenticate(req);
    } catch (err) {
      return json(res, err.httpStatus ?? 401, { error: err.message });
    }

    const match = routes.find((r) => r.method === req.method && r.re.test(path));
    if (!match) return json(res, 404, { error: `未找到路由 ${req.method} ${path}` });

    const captures = path.match(match.re).slice(1);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(captures[i])]));

    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, err.httpStatus ?? 400, { error: err.message });
      }
    }

    try {
      const result = await match.handler(actor, body, params);
      return json(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return json(res, err.httpStatus ?? 400, { error: err.message });
      }
      // eslint-disable-next-line no-console
      console.error(err);
      return json(res, 500, { error: '服务内部错误' });
    }
  });
}

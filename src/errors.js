export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHENTICATED', message = '缺少或未注册的教师身份') =>
  new HttpError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = '权限不足') => new HttpError(403, code, message);
export const notFound = (code = 'NOT_FOUND', message = '资源不存在') => new HttpError(404, code, message);
export const conflict = (code, message, details) => new HttpError(409, code, message, details);

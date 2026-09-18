// 领域错误类型，HTTP 层据此映射状态码
export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ValidationError extends DomainError {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.httpStatus = 400;
  }
}

export class AuthError extends DomainError {
  constructor(message = '缺少或携带了无效的身份凭证') {
    super(message);
    this.name = 'AuthError';
    this.httpStatus = 401;
  }
}

export class PermissionError extends DomainError {
  constructor(message = '当前身份无权执行该操作') {
    super(message);
    this.name = 'PermissionError';
    this.httpStatus = 403;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = '目标资源不存在') {
    super(message);
    this.name = 'NotFoundError';
    this.httpStatus = 404;
  }
}

export class ConflictError extends DomainError {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.httpStatus = 409;
  }
}

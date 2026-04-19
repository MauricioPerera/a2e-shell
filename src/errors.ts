export const ERROR_CODES = [
  "PARSE_ERROR",
  "CAPABILITY_DENIED",
  "INTERPOLATION_REJECTED",
  "SCOPE_MISS",
  "TIMEOUT",
  "SIZE_LIMIT",
  "UPSTREAM_ERROR",
  "INTERNAL",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "NOT_IMPLEMENTED_V1",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class A2EError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const httpStatusForCode: Record<ErrorCode, number> = {
  PARSE_ERROR: 400,
  CAPABILITY_DENIED: 403,
  INTERPOLATION_REJECTED: 400,
  SCOPE_MISS: 400,
  TIMEOUT: 200,
  SIZE_LIMIT: 200,
  UPSTREAM_ERROR: 200,
  INTERNAL: 500,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  NOT_IMPLEMENTED_V1: 400,
};

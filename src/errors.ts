export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "BAD_REQUEST"
  | "INTERNAL";

export class SimError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

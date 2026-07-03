import { HttpException } from "@nestjs/common";

// Local AppException (mirrors the access/pricing modules). Renders through
// http-exception.filter.ts: getResponse() -> { code, message, details? } and
// getStatus() -> status. Exposes code/statusCode/details as own props so
// AppError-style assertions (toMatchObject({ statusCode, code })) keep working.
// Relocate to core and re-point imports when core ships a shared AppException.
export class AppException extends HttpException {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(
      details !== undefined ? { code, message, details } : { code, message },
      status,
    );
    this.code = code;
    this.statusCode = status;
    this.details = details;
  }
}

import { HttpException } from "@nestjs/common";

/**
 * Coded domain error. The global HttpExceptionFilter renders the
 * `{ code, message, details? }` response shape into the error envelope. Port of
 * the legacy AppError.
 *
 * ponytail: duplicated per-module (forms, sponsorships) rather than hoisted —
 * hoist to apps/api/core when the churn justifies it.
 */
export class AppException extends HttpException {
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(
      details !== undefined ? { code, message, details } : { code, message },
      status,
    );
  }
}

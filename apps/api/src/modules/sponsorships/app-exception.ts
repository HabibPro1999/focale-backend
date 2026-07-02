import { HttpException } from "@nestjs/common";

/**
 * Coded domain error (port of legacy AppError). The global HttpExceptionFilter
 * recognises the `{ code, message, details? }` response shape and renders the
 * error envelope verbatim, with the same HTTP status.
 *
 * ponytail: duplicated per-module (forms/pricing do the same) until core ships a
 * shared AppException; this agent may not edit core.
 */
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

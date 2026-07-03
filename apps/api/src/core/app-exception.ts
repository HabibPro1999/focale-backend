import { HttpException } from "@nestjs/common";

/**
 * Coded domain error — the port of the legacy AppError. The global
 * HttpExceptionFilter recognises the `{ code, message, details? }` response
 * shape (isErrorBody) and renders the error envelope verbatim; getStatus()
 * supplies the HTTP status.
 *
 * `code`/`statusCode`/`details` are also exposed as own properties so
 * legacy AppError-style assertions (toMatchObject({ code, statusCode, details }))
 * keep working.
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

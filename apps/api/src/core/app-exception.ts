import { HttpException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";

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

/** Throw the standard coded 403 (shared by the tenant-gated controllers). */
export function forbidden(): never {
  throw new AppException(ErrorCodes.FORBIDDEN, "Insufficient permissions", 403);
}

/** Standard coded 404. */
export function notFound(message: string): AppException {
  return new AppException(ErrorCodes.NOT_FOUND, message, 404);
}

/** Standard coded 400 (VALIDATION_ERROR). */
export function badRequest(message: string): AppException {
  return new AppException(ErrorCodes.VALIDATION_ERROR, message, 400);
}

/** Standard coded 409. */
export function conflict(message: string): AppException {
  return new AppException(ErrorCodes.CONFLICT, message, 409);
}

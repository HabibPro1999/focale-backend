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

type ErrorOptions = { code?: string; details?: unknown };

/** Return coded errors; callers keep the throw at the original decision point. */
export function notFound(message: string, options: ErrorOptions = {}): AppException {
  return new AppException(options.code ?? ErrorCodes.NOT_FOUND, message, 404, options.details);
}

/** Generic Nest 400s map to VALIDATION_ERROR; domain/BAD_REQUEST codes stay explicit. */
export function badRequest(message: string, options: ErrorOptions = {}): AppException {
  return new AppException(options.code ?? ErrorCodes.VALIDATION_ERROR, message, 400, options.details);
}

export function conflict(message: string, options: ErrorOptions = {}): AppException {
  return new AppException(options.code ?? ErrorCodes.CONFLICT, message, 409, options.details);
}

/** Nullable lookups only: false, zero and empty strings are valid non-null values. */
export function orNotFound<T>(value: T | null | undefined, message: string, options: ErrorOptions = {}): T {
  if (value === null || value === undefined) throw notFound(message, options);
  return value;
}

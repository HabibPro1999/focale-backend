import { HttpException } from "@nestjs/common";

/**
 * Coded domain error. The global HttpExceptionFilter recognises the
 * `{ code, message, details? }` response shape and renders the error envelope
 * verbatim. Port of the legacy AppError.
 *
 * ponytail: lives in the forms module for now; hoist to apps/api/core when a
 * second domain needs it (the filter already understands the shape).
 */
export class AppException extends HttpException {
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(
      details !== undefined ? { code, message, details } : { code, message },
      status,
    );
  }
}

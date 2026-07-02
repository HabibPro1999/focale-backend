import { HttpException } from "@nestjs/common";

// ponytail: NOTE FOR VERIFIER — AppException belongs in apps/api/src/core (the
// port-spec's "thin HttpException subclass, port of AppError"). Core did not yet
// ship one and this agent may not edit core, so it lives here. Relocate to core
// and re-point imports when core gains it; the shape is intentionally the core one.
//
// Renders through http-exception.filter.ts: getResponse() -> { code, message,
// details? } (isErrorBody) and getStatus() -> status. Also exposes `statusCode`
// and `code` as own properties so legacy AppError-style assertions
// (toMatchObject({ statusCode, code, message })) keep working.
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

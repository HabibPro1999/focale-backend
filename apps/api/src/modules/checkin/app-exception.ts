import { HttpException } from "@nestjs/common";

// ponytail: NOTE FOR VERIFIER — AppException belongs in apps/api/src/core (the
// port-spec's "thin HttpException subclass, port of AppError"). Core did not ship
// one and this agent may not edit core, so it lives here (mirrors the access/
// pricing modules' local copies). Relocate to core and re-point imports when core
// gains it.
//
// Renders through http-exception.filter.ts: getResponse() -> { code, message,
// details? } (isErrorBody) and getStatus() -> status. Exposes `code`/`statusCode`/
// `details` as own props so AppError-style assertions (toMatchObject({ code,
// statusCode })) keep working.
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

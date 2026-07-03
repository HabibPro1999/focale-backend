import { HttpException } from "@nestjs/common";

// ponytail: local copy of the port-spec's AppException (thin HttpException
// subclass, port of legacy AppError). Core did not ship one and this agent may
// not edit core, so it lives here — mirrors the checkin/access/pricing modules'
// local copies. Relocate to core and re-point imports when core gains it.
//
// Renders through http-exception.filter.ts: getResponse() -> { code, message,
// details? } and getStatus() -> status. Exposes code/statusCode/details as own
// props so AppError-style assertions (toMatchObject({ code, statusCode })) work.
export class AppException extends HttpException {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(details !== undefined ? { code, message, details } : { code, message }, status);
    this.code = code;
    this.statusCode = status;
    this.details = details;
  }
}

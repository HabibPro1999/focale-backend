import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ErrorCodes, statusToCode, type ApiError } from "@app/contracts";
import { pgErrorCode, pgUniqueViolation } from "@app/db";
import type { FastifyReply } from "fastify";
import { getRequestId } from "./request-context";
import { logger } from "./logger.service";
import { ZodValidationException } from "./zod";

type ErrorBody = { code: string; message: string; details?: unknown };

function isErrorBody(v: unknown): v is ErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ErrorBody).code === "string" &&
    typeof (v as ErrorBody).message === "string"
  );
}

/**
 * Safety net for pg constraint errors that escape a service uncaught (e.g. a
 * pre-check + insert losing a concurrency race). Mirrors the legacy global
 * handler's Prisma mapping: 23505 unique_violation → 409 (email+form
 * registration constraint gets its domain code), 23503 foreign_key_violation
 * → 400. Returns null for anything that is not one of those.
 */
function mapPgConstraintError(
  exception: unknown,
): { status: HttpStatus; error: ErrorBody } | null {
  const code = pgErrorCode(exception);
  if (code === "23505") {
    const constraint = pgUniqueViolation(exception)?.constraint ?? "";
    if (/email/i.test(constraint) && /form/i.test(constraint)) {
      return {
        status: HttpStatus.CONFLICT,
        error: {
          code: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
          message: "A registration with this email already exists for this form",
        },
      };
    }
    return {
      status: HttpStatus.CONFLICT,
      error: { code: ErrorCodes.CONFLICT, message: "Resource already exists" },
    };
  }
  if (code === "23503") {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Referenced resource not found",
      },
    };
  }
  return null;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId() ?? "";

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: ErrorBody;
    const dbError = mapPgConstraintError(exception);

    if (exception instanceof ZodValidationException) {
      status = HttpStatus.BAD_REQUEST;
      error = {
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Validation failed",
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (isErrorBody(payload)) {
        error = payload;
      } else {
        const message =
          typeof payload === "string"
            ? payload
            : ((payload as { message?: unknown })?.message as string) ??
              exception.message;
        error = { code: statusToCode(status), message };
      }
    } else if (dbError !== null) {
      logger.warn({ err: exception }, "Database constraint error");
      status = dbError.status;
      error = dbError.error;
    } else {
      logger.error({ err: exception }, "Unhandled exception");
      const isProd = process.env.NODE_ENV === "production";
      error = {
        code: ErrorCodes.INTERNAL_ERROR,
        message: isProd
          ? "Internal server error"
          : exception instanceof Error
            ? exception.message
            : "Internal server error",
      };
    }

    const envelope: ApiError = { ok: false, error, requestId };
    void reply.header("x-request-id", requestId).status(status).send(envelope);
  }
}

import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ErrorCodes, statusToCode, type ApiError } from "@app/contracts";
import { sanitizeErrorForLog } from "@app/shared";
import { pgErrorCode, pgErrorLogFields, pgUniqueViolation } from "@app/db";
import type { FastifyReply } from "fastify";
import { CONFIG, type Config } from "./config";
import { getRequestId } from "./request-context";
import { logger } from "./logger.service";
import { ZodValidationException } from "./zod";
import { isParticipantNetworkingRequest } from "./networking-throttler.guard";

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
 * @app/integrations' framework-free IntegrationError (status/code/message,
 * optional details). Matched structurally rather than with instanceof so the
 * filter does not depend on the integrations module instance (tests mock it).
 */
interface IntegrationErrorLike extends Error {
  name: "IntegrationError";
  status: number;
  code: string;
  details?: Record<string, unknown>;
}

function isIntegrationError(value: unknown): value is IntegrationErrorLike {
  if (!(value instanceof Error) || value.name !== "IntegrationError") return false;
  const { status, code } = value as Partial<IntegrationErrorLike>;
  return (
    typeof code === "string" &&
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
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
  /** Non-production responses keep unhandled error messages for debugging. */
  private readonly exposeErrorMessages: boolean;

  constructor(@Optional() @Inject(CONFIG) config?: Pick<Config, "isProduction">) {
    // No injected config (bare unit fixtures): fail safe with production behavior.
    this.exposeErrorMessages = config ? !config.isProduction : false;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId() ?? "";
    // Organizer networking routes keep generic codes (VAL_2001 with details); only the PWA API is localized by code.
    const isNetworking = isParticipantNetworkingRequest(host.switchToHttp().getRequest());

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: ErrorBody;
    const dbError = mapPgConstraintError(exception);

    if (isNetworking && exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      error = { code: ErrorCodes.NETWORKING_RATE_LIMITED, message: "Too many requests" };
    } else if (exception instanceof ZodValidationException) {
      logger.warn({ details: exception.details }, "Request validation failed");
      status = HttpStatus.BAD_REQUEST;
      error = {
        code: isNetworking ? ErrorCodes.NETWORKING_VALIDATION : ErrorCodes.VALIDATION_ERROR,
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
      // 5xx HttpExceptions used to leave no trace. 503s are deliberate
      // back-pressure/unavailability signals, so they log at warn.
      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        logger.warn({ status, code: error.code }, "Service unavailable response");
      } else if (status >= 500) {
        logger.error({ err: exception, status, code: error.code }, "Server error response");
      }
    } else if (isIntegrationError(exception)) {
      // Coded integration failure (e.g. a rejected image → 400 INVALID_FILE_TYPE):
      // its own status, code and message instead of a generic 500.
      status = exception.status;
      error =
        exception.details !== undefined
          ? { code: exception.code, message: exception.message, details: exception.details }
          : { code: exception.code, message: exception.message };
      if (status >= 500) {
        logger.error({ err: exception, status, code: exception.code }, "Integration error");
      } else {
        logger.warn({ status, code: exception.code }, "Integration request rejected");
      }
    } else if (dbError !== null) {
      // Value-free: a Drizzle error message embeds the SQL + params and the pg
      // `detail` echoes row values (`Key (email)=(…)`).
      logger.warn({ ...pgErrorLogFields(exception) }, "Database constraint error");
      status = dbError.status;
      error = dbError.error;
    } else {
      // `err` goes through the shared sanitizing serializer (no SQL/params/detail).
      const dbFields = pgErrorLogFields(exception);
      logger.error({ ...dbFields, err: exception }, "Unhandled exception");
      error = {
        code: ErrorCodes.INTERNAL_ERROR,
        // Non-production keeps the message for debugging, minus SQL/params.
        message:
          !this.exposeErrorMessages || !(exception instanceof Error)
            ? "Internal server error"
            : (sanitizeErrorForLog(exception) as Error).message,
      };
    }

    const envelope: ApiError = { ok: false, error, requestId };
    void reply.header("x-request-id", requestId).status(status).send(envelope);
  }
}

import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ErrorCodes, statusToCode, type ApiError } from "@app/contracts";
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId() ?? "";

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: ErrorBody;

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
    } else {
      logger.error({ err: exception }, "Unhandled exception");
      const isProd = process.env.NODE_ENV === "production";
      error = {
        code: ErrorCodes.INTERNAL,
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

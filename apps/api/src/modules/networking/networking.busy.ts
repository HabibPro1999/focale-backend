import {
  HttpException,
  HttpStatus,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { catchError, throwError, type Observable } from "rxjs";
import { ErrorCodes } from "@app/contracts";
import { NetworkingBusyError, pgErrorLogFields } from "@app/db";
import { createLogger } from "@app/shared";

const log = createLogger({ name: "networking:busy" });

/** Seconds a client waits before retrying a write refused with NETWORKING_BUSY. */
export const NETWORKING_BUSY_RETRY_AFTER_SECONDS = 2;

/** 503 NETWORKING_BUSY: the write ran out of serialization retries and nothing was saved. */
export class NetworkingBusyException extends HttpException {
  constructor() {
    super(
      { code: ErrorCodes.NETWORKING_BUSY, message: "Networking is busy; retry in a moment" },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Maps NetworkingBusyError from the networking store to 503 NETWORKING_BUSY
 * with Retry-After. The header is set on the reply here; the global exception
 * filter then renders the HttpException into the usual error envelope.
 */
@Injectable()
export class NetworkingBusyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof NetworkingBusyError)) return throwError(() => error);
        log.warn({ ...pgErrorLogFields(error.cause) }, "Networking write ran out of serialization retries");
        const reply = context.switchToHttp().getResponse<FastifyReply>();
        if (!reply.sent) void reply.header("Retry-After", String(NETWORKING_BUSY_RETRY_AFTER_SECONDS));
        return throwError(() => new NetworkingBusyException());
      }),
    );
  }
}

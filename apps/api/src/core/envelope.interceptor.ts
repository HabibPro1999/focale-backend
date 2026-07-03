import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { map, type Observable } from "rxjs";
import { getRequestId } from "./request-context";

export const SKIP_ENVELOPE = "skipEnvelope";
/** Opt a handler/controller out of envelope wrapping (SSE, streams, raw responses). */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE, true);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);

    const reply = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      map((data) => {
        if (skip || reply.sent) return data;
        return { ok: true, data, requestId: getRequestId() };
      }),
    );
  }
}

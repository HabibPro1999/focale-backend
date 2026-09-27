import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "./authed-request";

/** Returns the client already loaded by AuthGuard; does not fetch a fallback. */
export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedRequest["client"] => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.client;
  },
);

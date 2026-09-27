import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ClientRow } from "@app/db";

/**
 * Returns the caller's client attached by AuthGuard (null when the user has
 * none). Not a route's target client: tenancy's @ScopedClient() carries that.
 */
export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientRow | null | undefined => {
    const req = ctx.switchToHttp().getRequest<{ client?: ClientRow | null }>();
    return req.client;
  },
);

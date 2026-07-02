import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "./user-cache";

/** Returns the DB-backed user (8-field allowlist) attached by AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    return req.user;
  },
);

import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { DecodedIdToken } from "firebase-admin/auth";

/** Returns the decoded Firebase user attached by AuthGuard. Undefined on unguarded routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DecodedIdToken | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: DecodedIdToken }>();
    return req.user;
  },
);

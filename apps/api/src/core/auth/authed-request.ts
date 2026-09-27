import type { FastifyRequest } from "fastify";
import type { AuthUser, CachedAuthUser } from "./user-cache";

/** AuthGuard attaches these fields after authentication succeeds. */
export type AuthedRequest = FastifyRequest & {
  user?: AuthUser;
  client?: CachedAuthUser["client"];
};

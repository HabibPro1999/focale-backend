import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";

export const ROLES_KEY = "roles";

/**
 * Opt-in auth. `@Auth()` requires a valid Firebase ID token; `@Auth('staff')`
 * additionally requires a matching `role` claim. There is NO global auth guard.
 */
export function Auth(...roles: string[]) {
  return applyDecorators(SetMetadata(ROLES_KEY, roles), UseGuards(AuthGuard));
}

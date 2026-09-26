import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import type { UserRoleValue } from "@app/contracts";
import { AuthGuard } from "./auth.guard";

export const ROLE_KEY = "authRole";

/**
 * Opt-in auth. `@Auth()` requires a valid Firebase ID token and an active
 * user/tenant. `@Auth(UserRole.SUPER_ADMIN)` additionally requires that role or
 * better (lower number): SUPER_ADMIN (0) => only 0; CLIENT_ADMIN (1) => 0 or 1.
 * Fail-closed. There is NO global auth guard.
 */
export function Auth(role?: UserRoleValue) {
  return applyDecorators(SetMetadata(ROLE_KEY, role), UseGuards(AuthGuard));
}

/**
 * Role requirement only (metadata, no guard) for a route whose controller
 * already has `@Auth()`: the class-level guard reads the handler's role before
 * the class's, so the token is verified once. Same "that role or better" rule
 * as `@Auth(role)`. Without an `@Auth()` on the class or method nothing
 * enforces it, so use `@Auth(role)` there instead.
 */
export function RequireRole(role: UserRoleValue) {
  return SetMetadata(ROLE_KEY, role);
}

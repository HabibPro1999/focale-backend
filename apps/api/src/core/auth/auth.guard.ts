import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ErrorCodes, UserRole } from "@app/contracts";
import { verifyToken } from "@app/integrations";
import { getUserWithClientById } from "@app/db";
import { ROLE_KEY } from "./auth.decorator";
import {
  userCache,
  type AuthUser,
  type CachedAuthUser,
} from "./user-cache";

type AuthedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
  client?: CachedAuthUser["client"];
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const header = req.headers["authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw?.startsWith("Bearer ")) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: "Missing or invalid authorization header",
      });
    }
    const token = raw.replace("Bearer ", "");

    try {
      const decoded = await verifyToken(token);

      let authUser = userCache.get(decoded.uid);
      if (!authUser) {
        const dbUser = await getUserWithClientById(decoded.uid);
        if (dbUser) {
          authUser = {
            // Explicit 8-field allowlist — do NOT spread the whole row.
            user: {
              id: dbUser.id,
              email: dbUser.email,
              name: dbUser.name,
              role: dbUser.role,
              clientId: dbUser.clientId,
              active: dbUser.active,
              createdAt: dbUser.createdAt,
              updatedAt: dbUser.updatedAt,
            },
            client: dbUser.client,
          };
          userCache.set(decoded.uid, authUser);
        }
      }

      if (!authUser) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: "User not found in database",
        });
      }
      if (!authUser.user.active) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: "User account is disabled",
        });
      }
      assertTenantClientActive(authUser);

      req.user = authUser.user;
      req.client = authUser.client;
    } catch (error) {
      // Deliberate auth failures (401/403 above) keep their status/code/message.
      // Any other error (token verify failure, etc.) is masked as a generic 401
      // — Firebase detail is never leaked.
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_TOKEN,
        message: "Invalid or expired token",
      });
    }

    // Role gate (separate from token verification, so its 403 is never masked).
    const requiredRole = this.reflector.getAllAndOverride<number | undefined>(
      ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredRole !== undefined) {
      if (!req.user) {
        throw new UnauthorizedException({
          code: ErrorCodes.UNAUTHORIZED,
          message: "Authentication required",
        });
      }
      // `@Auth(role)` = that role or better (lower number). Fail-closed.
      if (!(req.user.role <= requiredRole)) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          message: "Insufficient permissions",
        });
      }
    }

    return true;
  }
}

/** Non-super-admin users with a clientId must belong to an active client. */
function assertTenantClientActive(authUser: CachedAuthUser): void {
  if (authUser.user.role === UserRole.SUPER_ADMIN || !authUser.user.clientId) {
    return;
  }
  if (authUser.client?.active !== true) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      message: "Client is inactive",
    });
  }
}

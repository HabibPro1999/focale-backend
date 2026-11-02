import { logger } from "../logger.service";
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
import { getDb, getUserWithClientById, recordUserLogin } from "@app/db";
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
            // Explicit allowlist — do NOT spread the whole row.
            user: {
              id: dbUser.id,
              email: dbUser.email,
              name: dbUser.name,
              role: dbUser.role,
              clientId: dbUser.clientId,
              active: dbUser.active,
              createdAt: dbUser.createdAt,
              updatedAt: dbUser.updatedAt,
              lastLoginAt: dbUser.lastLoginAt ?? null,
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
          code: ErrorCodes.USER_INACTIVE,
          message: "User account is disabled",
        });
      }
      assertTenantClientActive(authUser);

      // auth_time is the verified sign-in time, unlike token iat or request time.
      const loginSeconds = decoded.auth_time;
      if (Number.isSafeInteger(loginSeconds) && loginSeconds > 0 && loginSeconds * 1000 <= Date.now() + 60_000 &&
          loginSeconds * 1000 > (authUser.user.lastLoginAt?.getTime() ?? 0)) {
        const at = new Date(loginSeconds * 1000);
        try {
          await recordUserLogin(decoded.uid, at, getDb());
          authUser.user.lastLoginAt = at;
        } catch {
          // Analytics metadata must not turn a valid login into INVALID_TOKEN.
          logger.warn("Failed to record authenticated login time");
        }
      }

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
      logger.warn({ err: error }, "Firebase token verification failed");
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
      code: ErrorCodes.CLIENT_INACTIVE,
      message: "Client is inactive",
    });
  }
}

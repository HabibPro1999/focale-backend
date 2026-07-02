import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ErrorCodes } from "@app/contracts";
import type { DecodedIdToken } from "firebase-admin/auth";
import { verifyIdToken } from "./firebase";
import { ROLES_KEY } from "./auth.decorator";

type AuthedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: DecodedIdToken;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers["authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith("Bearer ") ? raw.slice(7).trim() : undefined;

    if (!token) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: "Missing bearer token",
      });
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await verifyIdToken(token);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: "Invalid or expired token",
      });
    }
    req.user = decoded;

    const roles =
      this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (roles.length > 0) {
      const claim = (decoded as { role?: string }).role;
      if (!claim || !roles.includes(claim)) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          message: "Insufficient role",
        });
      }
    }

    return true;
  }
}

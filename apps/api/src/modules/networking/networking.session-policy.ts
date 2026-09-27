import { UnauthorizedException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";

export const networkingSessionExpired = (message = "Participant session expired") =>
  new UnauthorizedException({ code: ErrorCodes.NETWORKING_SESSION_EXPIRED, message });
export const networkingBearer = (authorization?: string) =>
  authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];

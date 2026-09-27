import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ErrorCodes, type NetworkingConfig } from "@app/contracts";

// Keep Nest classes: connectionWith catches NotFoundException specifically.
export const networkingNotFound = (message: string) =>
  new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message });
export const networkingValidation = (message: string, details?: unknown) =>
  new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message, ...(details ? { details } : {}) });
export const networkingFeatureDisabled = (message: string) =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message });

export function requireNetworkingDiscovery(config: Pick<NetworkingConfig, "swipeEnabled" | "searchEnabled">, message = "Discovery is disabled") {
  if (!config.swipeEnabled && !config.searchEnabled) throw networkingFeatureDisabled(message);
}
export function requireNetworkingChat(config: Pick<NetworkingConfig, "chatEnabled">) {
  if (!config.chatEnabled) throw networkingFeatureDisabled("Chat is disabled");
}

export const networkingSessionExpired = (message = "Participant session expired") =>
  new UnauthorizedException({ code: ErrorCodes.NETWORKING_SESSION_EXPIRED, message });

export function assertNetworkingSecondFactor(
  config: Pick<NetworkingConfig, "requireSecondFactor">,
  secondFactorEnabled: boolean,
  session: { secondFactorVerifiedAt: Date | null },
  options: { allowPending?: boolean } = {},
) {
  if ((config.requireSecondFactor || secondFactorEnabled) && !session.secondFactorVerifiedAt && !options.allowPending)
    throw new ForbiddenException({ code: ErrorCodes.NETWORKING_MFA_REQUIRED, message: "Authenticator verification is required" });
}

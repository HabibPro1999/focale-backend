import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";

// Keep Nest exception classes: callers intentionally turn only NotFoundException into null.
export const networkingNotFound = (message: string) =>
  new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message });
export const networkingValidation = (message: string, details?: unknown) =>
  new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message, ...(details ? { details } : {}) });
export const networkingFeatureDisabled = (message: string) =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message });
export const networkingLocked = (message: string) =>
  new ConflictException({ code: ErrorCodes.NETWORKING_MEETING_LOCKED, message });
export const networkingSlotConflict = (message: string) =>
  new ConflictException({ code: ErrorCodes.NETWORKING_SLOT_CONFLICT, message });
export const networkingNotEligible = (message: string) =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_NOT_ELIGIBLE, message });

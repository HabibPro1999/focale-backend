import * as c from "@app/contracts";
import { createZodDto } from "../../core/zod";
export class NetworkingConfigDto extends createZodDto(
  c.UpdateNetworkingConfigSchema,
) {}
export class NetworkingProfileDto extends createZodDto(
  c.NetworkingProfileUpdateSchema,
) {}
export class NetworkingAdminProfileDto extends createZodDto(
  c.NetworkingAdminProfileUpdateSchema,
) {}
export class NetworkingListDto extends createZodDto(
  c.NetworkingListQuerySchema,
) {}
export class NetworkingOtpRequestDto extends createZodDto(
  c.NetworkingOtpRequestSchema,
) {}
export class NetworkingOtpVerifyDto extends createZodDto(
  c.NetworkingOtpVerifySchema,
) {}
export class NetworkingInterestDto extends createZodDto(
  c.NetworkingInterestSchema,
) {}
export class NetworkingMessageDto extends createZodDto(
  c.NetworkingMessageSchema,
) {}
export class NetworkingBlockDto extends createZodDto(c.NetworkingBlockSchema) {}
export class NetworkingReportDto extends createZodDto(
  c.NetworkingReportSchema,
) {}
export class NetworkingReportActionDto extends createZodDto(
  c.NetworkingReportActionSchema,
) {}
export class NetworkingAvailabilityDto extends createZodDto(
  c.NetworkingAvailabilitySchema,
) {}
export class NetworkingMeetingCreateDto extends createZodDto(
  c.NetworkingMeetingCreateSchema,
) {}
export class NetworkingMeetingRespondDto extends createZodDto(
  c.NetworkingMeetingRespondSchema,
) {}
export class NetworkingAdminMeetingDto extends createZodDto(
  c.NetworkingAdminMeetingUpdateSchema,
) {}
export class NetworkingTableDto extends createZodDto(c.NetworkingTableSchema) {}
export class NetworkingSpaceDto extends createZodDto(c.NetworkingSpaceSchema) {}
export class NetworkingSpaceUpdateDto extends createZodDto(c.NetworkingSpaceUpdateSchema) {}
export class NetworkingTableUpdateDto extends createZodDto(
  c.NetworkingTableUpdateSchema,
) {}
export class NetworkingNotificationReadDto extends createZodDto(
  c.NetworkingNotificationReadSchema,
) {}
export class NetworkingPushDto extends createZodDto(c.NetworkingPushSchema) {}
export class NetworkingCheckinDto extends createZodDto(
  c.NetworkingCheckinSchema,
) {}

export class NetworkingMfaCodeDto extends createZodDto(
  c.NetworkingMfaCodeSchema,
) {}

export class NetworkingBadgeVerifyDto extends createZodDto(
  c.NetworkingBadgeVerifySchema,
) {}

export class NetworkingParticipantListDto extends createZodDto(c.NetworkingParticipantListQuerySchema) {}

export class NetworkingCalendarDto extends createZodDto(c.NetworkingCalendarQuerySchema) {}

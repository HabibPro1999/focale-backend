import { z } from "zod";
import {
  NetworkingAdminConfigSchema,
  NetworkingSyncStateSchema,
  NetworkingStoredProfileSchema,
  NetworkingSpaceRowSchema,
  NetworkingDeletedSchema,
  NetworkingAdminTableRowSchema,
  NetworkingSavedTableSchema,
  NetworkingOrganizerMeetingSchema,
  NetworkingMeetingRowSchema,
  NetworkingReportRowSchema,
  NetworkingMessageRowSchema,
  NetworkingVisibleProfileSchema,
} from "./networking.response-rows";

/** NetworkingAdminController.config */
export const NetworkingAdminConfigResponseSchema = NetworkingAdminConfigSchema;

/** NetworkingAdminController.updateConfig */
export const NetworkingAdminUpdateConfigResponseSchema = NetworkingAdminConfigSchema;

/** NetworkingAdminController.uploadLogo */
export const NetworkingAdminUploadLogoResponseSchema = z.object({
  url: z.string(),
  resource: NetworkingAdminConfigSchema,
});

/** NetworkingAdminController.sync */
export const NetworkingAdminSyncResponseSchema = NetworkingSyncStateSchema;

/** NetworkingAdminController.syncState */
export const NetworkingAdminSyncStateResponseSchema = NetworkingSyncStateSchema;

/** NetworkingAdminController.profiles */
export const NetworkingAdminProfilesResponseSchema = z.object({
  items: z.array(NetworkingStoredProfileSchema.extend({
    matchCount: z.number(),
    meetingCount: z.number(),
  })),
  total: z.number(),
});

/** NetworkingAdminController.updateProfile */
export const NetworkingAdminUpdateProfileResponseSchema = NetworkingStoredProfileSchema;

/** NetworkingAdminController.spaces */
export const NetworkingAdminSpacesResponseSchema = z.object({
  items: z.array(NetworkingSpaceRowSchema.extend({
    allocatedCount: z.number(),
  })),
  total: z.number(),
});

/** NetworkingAdminController.createSpace */
export const NetworkingAdminCreateSpaceResponseSchema = NetworkingSpaceRowSchema;

/** NetworkingAdminController.updateSpace */
export const NetworkingAdminUpdateSpaceResponseSchema = NetworkingSpaceRowSchema;

/** NetworkingAdminController.removeSpace */
export const NetworkingAdminRemoveSpaceResponseSchema = NetworkingDeletedSchema;

/** NetworkingAdminController.tables */
export const NetworkingAdminTablesResponseSchema = z.object({
  items: z.array(NetworkingAdminTableRowSchema),
  total: z.number(),
});

/** NetworkingAdminController.table */
export const NetworkingAdminTableResponseSchema = NetworkingSavedTableSchema;

/** NetworkingAdminController.updateTable */
export const NetworkingAdminUpdateTableResponseSchema = NetworkingSavedTableSchema;

/** NetworkingAdminController.removeTable */
export const NetworkingAdminRemoveTableResponseSchema = NetworkingDeletedSchema;

/** NetworkingAdminController.meetings */
export const NetworkingAdminMeetingsResponseSchema = z.object({
  items: z.array(NetworkingOrganizerMeetingSchema),
  total: z.number(),
});

/** NetworkingAdminController.calendar */
export const NetworkingAdminCalendarResponseSchema = z.object({
  date: z.string(),
  timezone: z.string(),
  items: z.array(NetworkingMeetingRowSchema.extend({
    requester: NetworkingStoredProfileSchema.nullable(),
    recipient: NetworkingStoredProfileSchema.nullable(),
    table: NetworkingAdminTableRowSchema.nullable(),
  })),
});

/** NetworkingAdminController.updateMeeting */
export const NetworkingAdminUpdateMeetingResponseSchema = NetworkingOrganizerMeetingSchema;

/** NetworkingAdminController.reports */
export const NetworkingAdminReportsResponseSchema = z.object({
  items: z.array(NetworkingReportRowSchema.extend({
    reporter: NetworkingStoredProfileSchema.nullable(),
    profile: NetworkingStoredProfileSchema.nullable(),
    message: NetworkingMessageRowSchema.nullable(),
  })),
  total: z.number(),
});

/** NetworkingAdminController.moderate */
export const NetworkingAdminModerateResponseSchema = NetworkingReportRowSchema;

/** NetworkingAdminController.audit */
export const NetworkingAdminAuditResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    eventId: z.string(),
    actorId: z.string(),
    action: z.string(),
    targetId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    createdAt: z.date(),
  })),
  total: z.number(),
});

/** NetworkingAdminController.verifyBadge */
export const NetworkingAdminVerifyBadgeResponseSchema = z.object({
  accessAllowed: z.boolean(),
  profile: NetworkingVisibleProfileSchema,
  accessId: z.string().nullable(),
});

/** NetworkingAdminController.regeneratePostEventReport */
export const NetworkingAdminRegeneratePostEventReportResponseSchema = z.object({
  deliveryId: z.string(),
  availableAt: z.date(),
  version: z.string(),
});

/** NetworkingAdminController.postEventReport */
export const NetworkingAdminPostEventReportResponseSchema = z.object({
  available: z.boolean(),
  url: z.string().optional(),
  generatedAt: z.string().optional(),
  summary: z.record(z.string(), z.number()).optional(),
});

/** NetworkingAdminController.analytics */
export const NetworkingAdminAnalyticsResponseSchema = z.object({
  emailSent: z.number().optional(),
  emailDelivered: z.number().optional(),
  emailOpened: z.number().optional(),
  emailClicked: z.number().optional(),
  emailFailed: z.number().optional(),
  profileViews: z.number(),
  activationRate: z.number(),
  conversations: z.number(),
  responseRate: z.number(),
  meetingConversionRate: z.number(),
  profiles: z.number(),
  activeProfiles: z.number(),
  visibleProfiles: z.number(),
  likes: z.number(),
  passes: z.number(),
  matches: z.number(),
  matchRate: z.number(),
  messages: z.number(),
  meetings: z.number(),
  confirmedMeetings: z.number(),
  completedMeetings: z.number(),
  cancelledMeetings: z.number(),
  noShowMeetings: z.number(),
  pendingMeetings: z.number(),
  tableOccupancyRate: z.number(),
  reports: z.number(),
  hourlyActivity: z.array(z.object({
    hour: z.string(),
    activity: z.number(),
  })).optional(),
  timeSeries: z.array(z.object({
    date: z.string(),
    bookingRequests: z.number().optional(),
    matches: z.number(),
    messages: z.number(),
    meetings: z.number(),
  })),
  sectors: z.array(z.object({
    sector: z.string(),
    participants: z.number(),
    matches: z.number(),
    meetings: z.number(),
  })),
  engagement: z.array(z.object({
    profileId: z.string(),
    name: z.string(),
    matches: z.number(),
    messages: z.number(),
    meetings: z.number(),
  })),
  engagementTotal: z.number().optional(),
});

import { z } from "zod";
import {
  NetworkingAdminConfigUiLabelsItemSchema,
  NetworkingAdminConfigFieldMappingSchema,
  NetworkingAdminConfigOpeningHoursItemSchema,
  NetworkingStoredProfileSchema,
  NetworkingVisibleProfileSchema,
  NetworkingFacetSchema,
  NetworkingConnectionSummarySchema,
  NetworkingMessageRowSchema,
  NetworkingReadSchema,
  NetworkingReportRowSchema,
  NetworkingParticipantMeetingSchema,
} from "./networking.response-rows";

/** NetworkingPublicController.config */
export const NetworkingPublicConfigResponseSchema = z.object({
  event: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    startsAt: z.date(),
    endsAt: z.date(),
    location: z.string().nullable(),
    bannerUrl: z.string().nullable(),
  }),
  config: z.object({
    enabled: z.boolean(),
    requireSecondFactor: z.boolean(),
    approvalMode: z.enum(["MANUAL", "AUTOMATIC"]),
    swipeEnabled: z.boolean(),
    searchEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    meetingsEnabled: z.boolean(),
    autoAssignTables: z.boolean(),
    slotDurationMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
    timezone: z.string(),
    requestExpiryHours: z.number(),
    languages: z.array(z.enum(["fr", "en", "ar"])),
    defaultLanguage: z.enum(["fr", "en", "ar"]),
    primaryColor: z.string(),
    welcomeMessage: z.string(),
    participantLabel: z.string(),
    tableLabel: z.string(),
    helpMessage: z.string(),
    uiLabels: z.record(z.string(), NetworkingAdminConfigUiLabelsItemSchema),
    accessInstructions: z.string(),
    fieldMapping: NetworkingAdminConfigFieldMappingSchema,
    openingHours: z.array(NetworkingAdminConfigOpeningHoursItemSchema),
    blackoutSlots: z.array(z.string()),
    requiredAccessId: z.string().nullable().optional(),
    opensAt: z.string().nullable().optional(),
    closesAt: z.string().nullable().optional(),
    logoUrl: z.string().nullable().optional(),
    supportEmail: z.string().nullable().optional(),
    supportPhone: z.string().nullable().optional(),
    accessPlanUrl: z.string().nullable().optional(),
  }),
  pushPublicKey: z.string().nullable(),
  networkingUrl: z.string().optional(),
});

/** NetworkingPublicController.registration */
export const NetworkingPublicRegistrationResponseSchema = z.union([z.object({
  enabled: z.literal(false),
}), z.object({
  enabled: z.literal(true),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  approvalMode: z.enum(["MANUAL", "AUTOMATIC"]),
  fieldMapping: z.object({
    company: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    sector: z.string().nullable().optional(),
    bio: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    interests: z.string().nullable().optional(),
    offers: z.string().nullable().optional(),
    seeks: z.string().nullable().optional(),
    consent: z.string().nullable().optional(),
  }),
  networkingUrl: z.string().optional(),
})]);

/** NetworkingPublicController.requestCode */
export const NetworkingPublicRequestCodeResponseSchema = z.object({
  challengeId: z.string(),
});

/** NetworkingPublicController.verifyCode */
export const NetworkingPublicVerifyCodeResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.date(),
  profile: NetworkingStoredProfileSchema,
  requiresSecondFactor: z.boolean(),
  mfaEnrollmentRequired: z.boolean(),
});

/** NetworkingPublicController.logout */
export const NetworkingPublicLogoutResponseSchema = z.object({
  loggedOut: z.boolean(),
});

/** NetworkingPublicController.me */
export const NetworkingPublicMeResponseSchema = NetworkingStoredProfileSchema;

/** NetworkingPublicController.personalAnalytics */
export const NetworkingPublicPersonalAnalyticsResponseSchema = z.object({
  currentEventId: z.string(),
  events: z.array(z.object({
    eventId: z.string(),
    eventName: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    profileViews: z.number(),
    matches: z.number(),
    sentMessages: z.number(),
    plannedMeetings: z.number(),
    completedMeetings: z.number(),
  })),
});

/** NetworkingPublicController.updateMe */
export const NetworkingPublicUpdateMeResponseSchema = NetworkingStoredProfileSchema;

/** NetworkingPublicController.uploadPhoto */
export const NetworkingPublicUploadPhotoResponseSchema = z.object({
  url: z.string(),
  resource: NetworkingStoredProfileSchema,
});

/** NetworkingPublicController.incomingInterests */
export const NetworkingPublicIncomingInterestsResponseSchema = z.object({
  total: z.number().optional(),
  items: z.array(z.object({
    id: z.string(),
    profile: NetworkingVisibleProfileSchema,
    createdAt: z.date(),
  })),
  nextCursor: z.string().nullable(),
});

/** NetworkingPublicController.facets */
export const NetworkingPublicFacetsResponseSchema = z.object({
  sectors: z.array(NetworkingFacetSchema),
  companies: z.array(NetworkingFacetSchema),
  cities: z.array(NetworkingFacetSchema),
  countries: z.array(NetworkingFacetSchema),
});

/** NetworkingPublicController.profiles */
export const NetworkingPublicProfilesResponseSchema = z.object({
  items: z.array(NetworkingVisibleProfileSchema),
  total: z.number(),
});

/** NetworkingPublicController.representatives */
export const NetworkingPublicRepresentativesResponseSchema = z.object({
  items: z.array(NetworkingVisibleProfileSchema),
  total: z.number(),
  exhibitor: z.object({
    id: z.string(),
    name: z.string(),
    spaceName: z.string().nullable(),
  }).nullable(),
});

/** NetworkingPublicController.profile */
export const NetworkingPublicProfileResponseSchema = NetworkingVisibleProfileSchema;

/** NetworkingPublicController.interest */
export const NetworkingPublicInterestResponseSchema = z.object({
  matched: z.boolean(),
  connectionId: z.string().optional(),
});

/** NetworkingPublicController.resetInterests */
export const NetworkingPublicResetInterestsResponseSchema = z.object({
  reset: z.boolean(),
});

/** NetworkingPublicController.connections */
export const NetworkingPublicConnectionsResponseSchema = z.object({
  total: z.number().optional(),
  items: z.array(NetworkingConnectionSummarySchema),
  nextCursor: z.string().nullable(),
});

/** NetworkingPublicController.connectionWith */
export const NetworkingPublicConnectionWithResponseSchema = z.object({
  connection: NetworkingConnectionSummarySchema.nullable(),
});

/** NetworkingPublicController.connection */
export const NetworkingPublicConnectionResponseSchema = NetworkingConnectionSummarySchema;

/** NetworkingPublicController.messages */
export const NetworkingPublicMessagesResponseSchema = z.object({
  items: z.array(NetworkingMessageRowSchema),
  total: z.number(),
  nextCursor: z.object({
    before: z.string(),
    beforeId: z.string(),
  }).nullable(),
});

/** NetworkingPublicController.message */
export const NetworkingPublicMessageResponseSchema = NetworkingMessageRowSchema;

/** NetworkingPublicController.read */
export const NetworkingPublicReadResponseSchema = NetworkingReadSchema;

/** NetworkingPublicController.blocks */
export const NetworkingPublicBlocksResponseSchema = z.object({
  items: z.array(z.object({
    profile: NetworkingVisibleProfileSchema.nullable(),
    id: z.string(),
    createdAt: z.date(),
    eventId: z.string(),
    profileId: z.string(),
    targetId: z.string(),
  })),
  total: z.number(),
});

/** NetworkingPublicController.block */
export const NetworkingPublicBlockResponseSchema = z.object({
  blocked: z.boolean(),
});

/** NetworkingPublicController.unblock */
export const NetworkingPublicUnblockResponseSchema = z.object({
  unblocked: z.boolean(),
});

/** NetworkingPublicController.report */
export const NetworkingPublicReportResponseSchema = NetworkingReportRowSchema;

/** NetworkingPublicController.availability */
export const NetworkingPublicAvailabilityResponseSchema = z.object({
  slots: z.array(z.string()),
  freeSlots: z.array(z.string()),
  bookedSlots: z.array(z.string()),
  availableSlots: z.array(z.string()),
});

/** NetworkingPublicController.updateAvailability */
export const NetworkingPublicUpdateAvailabilityResponseSchema = z.object({
  slots: z.array(z.string()),
});

/** NetworkingPublicController.profileAvailability */
export const NetworkingPublicProfileAvailabilityResponseSchema = z.object({
  slots: z.array(z.string()),
  availableSlots: z.array(z.string()),
});

/** NetworkingPublicController.listMeetings */
export const NetworkingPublicListMeetingsResponseSchema = z.object({
  total: z.number().optional(),
  items: z.array(NetworkingParticipantMeetingSchema),
  nextCursor: z.string().nullable(),
});

/** NetworkingPublicController.meeting */
export const NetworkingPublicMeetingResponseSchema = NetworkingParticipantMeetingSchema;

/** NetworkingPublicController.createMeeting */
export const NetworkingPublicCreateMeetingResponseSchema = NetworkingParticipantMeetingSchema;

/** NetworkingPublicController.respond */
export const NetworkingPublicRespondResponseSchema = NetworkingParticipantMeetingSchema;

/** NetworkingPublicController.checkin */
export const NetworkingPublicCheckinResponseSchema = NetworkingParticipantMeetingSchema;

/** NetworkingPublicController.badge */
export const NetworkingPublicBadgeResponseSchema = z.object({
  accessAllowed: z.boolean(),
  token: z.string(),
  expiresAt: z.string(),
  profileId: z.string(),
});

/** NetworkingPublicController.notifications */
export const NetworkingPublicNotificationsResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    eventId: z.string(),
    profileId: z.string(),
    type: z.string(),
    title: z.string(),
    body: z.string(),
    href: z.string(),
    data: z.record(z.string(), z.unknown()),
    readAt: z.date().nullable(),
    createdAt: z.date(),
  })),
  total: z.number(),
  unreadCount: z.number(),
  unreadMessageCount: z.number(),
});

/** NetworkingPublicController.readNotifications */
export const NetworkingPublicReadNotificationsResponseSchema = NetworkingReadSchema;

/** NetworkingPublicController.subscribe */
export const NetworkingPublicSubscribeResponseSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  eventId: z.string(),
  profileId: z.string(),
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  expirationTime: z.date().nullable(),
});

/** NetworkingPublicController.unsubscribe */
export const NetworkingPublicUnsubscribeResponseSchema = z.object({
  unsubscribed: z.boolean(),
});

/** NetworkingPublicController.withdraw */
export const NetworkingPublicWithdrawResponseSchema = z.object({
  withdrawn: z.boolean(),
});

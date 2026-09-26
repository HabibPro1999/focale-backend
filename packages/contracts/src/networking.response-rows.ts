import { z } from "zod";

// Networking response payloads: Dates are serialized to ISO strings by HTTP.
// Every row is closed; only stored extensible JSON documents remain opaque.

export const NetworkingAdminConfigUiLabelsItemSchema = z.object({
  fr: z.string(),
  en: z.string().optional(),
  ar: z.string().optional(),
});

export const NetworkingAdminConfigEmailTemplatesItemSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export const NetworkingAdminConfigFieldMappingSchema = z.object({
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  sector: z.string().optional(),
  bio: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  website: z.string().optional(),
  photoUrl: z.string().optional(),
  interests: z.string().optional(),
  offers: z.string().optional(),
  seeks: z.string().optional(),
  consent: z.string().optional(),
});

export const NetworkingAdminConfigOpeningHoursItemSchema = z.object({
  date: z.string(),
  start: z.string(),
  end: z.string(),
});

export const NetworkingAdminConfigSchema = z.object({
  enabled: z.boolean(),
  requireSecondFactor: z.boolean(),
  approvalMode: z.enum(["MANUAL", "AUTOMATIC"]),
  eligiblePaymentStatuses: z.array(z.enum(["PENDING", "VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"])),
  swipeEnabled: z.boolean(),
  searchEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  meetingsEnabled: z.boolean(),
  autoAssignTables: z.boolean(),
  slotDurationMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  timezone: z.string(),
  retentionDays: z.number(),
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
  emailTemplates: z.record(z.string(), NetworkingAdminConfigEmailTemplatesItemSchema),
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
  revision: z.string(),
});

export const NetworkingSyncStateSchema = z.object({
  runId: z.string().nullable(),
  status: z.enum(["IDLE", "RUNNING", "COMPLETED"]),
  total: z.number(),
  processed: z.number(),
  created: z.number(),
  updated: z.number(),
  failed: z.number(),
  requestedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  lastError: z.string().nullable(),
});

export const NetworkingVisibleProfileSchema = z.object({
  meetingsEnabled: z.boolean(),
  company: z.string(),
  jobTitle: z.string(),
  sector: z.string(),
  bio: z.string(),
  city: z.string(),
  country: z.string(),
  website: z.string().nullable(),
  photoUrl: z.string().nullable(),
  interests: z.array(z.string()),
  offers: z.string(),
  seeks: z.string(),
  consent: z.boolean(),
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  eventId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  visible: z.boolean(),
  lastActiveAt: z.date().nullable(),
  erasedAt: z.date().nullable(),
  featured: z.boolean(),
  standTableId: z.string().nullable(),
});

export const NetworkingStoredProfileSchema = NetworkingVisibleProfileSchema.extend({
  email: z.string(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "EXCLUDED"]),
  registrationId: z.string(),
  emailPreference: z.enum(["IMMEDIATE", "DAILY", "OFF"]),
  language: z.enum(["fr", "en", "ar"]),
  availabilitySet: z.boolean(),
  consentAt: z.date().nullable(),
  withdrawnAt: z.date().nullable(),
  overrides: z.record(z.string(), z.unknown()),
});

export const NetworkingSpaceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  location: z.string(),
  eventId: z.string(),
  kind: z.enum(["TABLE", "STAND"]),
  capacity: z.number(),
});

export const NetworkingDeletedSchema = z.object({
  deleted: z.boolean(),
});

export const NetworkingRepresentativeSummarySchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  company: z.string(),
});

export const NetworkingTableBaseSchema = NetworkingSpaceRowSchema.extend({
  spaceId: z.string().nullable(),
  ownerProfileId: z.string().nullable(),
});

export const NetworkingTableWithSpaceSchema = NetworkingTableBaseSchema.extend({
  space: NetworkingSpaceRowSchema.nullable(),
});

export const NetworkingAdminTableRowSchema = NetworkingTableWithSpaceSchema.extend({
  representativeIds: z.array(z.string()),
  representatives: z.array(NetworkingRepresentativeSummarySchema),
});

export const NetworkingSavedTableSchema = NetworkingTableBaseSchema.extend({
  representativeIds: z.array(z.string()),
  space: NetworkingSpaceRowSchema,
});

export const NetworkingMeetingRowSchema = z.object({
  message: z.string(),
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  status: z.enum(["PENDING", "COMPLETED", "PENDING_ALLOCATION", "CONFIRMED", "DECLINED", "CANCELLED", "EXPIRED", "NO_SHOW"]),
  tableId: z.string().nullable(),
  eventId: z.string(),
  expiresAt: z.date(),
  startsAt: z.date(),
  requesterId: z.string(),
  recipientId: z.string(),
  endsAt: z.date(),
  cancellationNote: z.string(),
  proposedStartsAt: z.date().nullable(),
  proposalBy: z.string().nullable(),
  revision: z.number(),
  requesterCheckedInAt: z.date().nullable(),
  recipientCheckedInAt: z.date().nullable(),
});

export const NetworkingOrganizerMeetingSchema = NetworkingMeetingRowSchema.extend({
  requester: NetworkingStoredProfileSchema.nullable(),
  recipient: NetworkingStoredProfileSchema.nullable(),
  table: NetworkingTableWithSpaceSchema.nullable(),
});

export const NetworkingMessageRowSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  connectionId: z.string(),
  senderId: z.string(),
  body: z.string(),
  clientMessageId: z.string(),
  createdAt: z.date(),
});

export const NetworkingReportRowSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]),
  eventId: z.string(),
  note: z.string().nullable(),
  profileId: z.string(),
  reporterId: z.string(),
  messageId: z.string().nullable(),
  reason: z.string(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.date().nullable(),
});

export const NetworkingFacetSchema = z.object({
  value: z.string(),
  count: z.number(),
});

export const NetworkingMessageSummarySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  senderId: z.string(),
  body: z.string(),
  createdAt: z.date(),
});

export const NetworkingConnectionSummarySchema = z.object({
  profile: NetworkingVisibleProfileSchema,
  id: z.string(),
  createdAt: z.date(),
  lastMessage: NetworkingMessageSummarySchema.nullable(),
  unreadCount: z.number(),
});

export const NetworkingReadSchema = z.object({
  read: z.boolean(),
});

export const NetworkingParticipantMeetingSchema = NetworkingMeetingRowSchema.extend({
  requester: NetworkingVisibleProfileSchema.nullable(),
  recipient: NetworkingVisibleProfileSchema.nullable(),
  table: NetworkingTableWithSpaceSchema.nullable(),
});

export const NetworkingMfaVerificationSchema = z.object({
  recoveryCodesOutdated: z.boolean().optional(),
  recoveryCodes: z.array(z.string()).optional(),
  verified: z.boolean(),
});

export const NetworkingRecommendedProfileSchema = NetworkingVisibleProfileSchema.extend({
  score: z.number(),
  reasons: z.array(z.string()),
});

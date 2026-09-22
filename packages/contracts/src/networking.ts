import { z } from "zod";
import { PaymentStatusSchema } from "./registrations";

export const NETWORKING_PROFILE_STATUSES = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EXCLUDED",
] as const;
export const NETWORKING_MEETING_STATUSES = [
  "PENDING",
  "PENDING_ALLOCATION",
  "CONFIRMED",
  "DECLINED",
  "CANCELLED",
  "EXPIRED",
  "COMPLETED",
  "NO_SHOW",
] as const;
const id = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const url = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => /^https?:\/\//i.test(value),
    "Only HTTP(S) URLs are allowed",
  );
const nullableUrl = url.nullable().optional();
export const NETWORKING_PROFESSIONAL_FIELDS = [
  "company", "jobTitle", "sector", "bio", "city", "country", "website",
  "photoUrl", "interests", "offers", "seeks",
] as const;
export function networkingProfileComplete(profile: {
  firstName?: string; lastName?: string; company?: string; jobTitle?: string; sector?: string;
}) {
  return [profile.firstName, profile.lastName, profile.company, profile.jobTitle, profile.sector]
    .every(value => typeof value === "string" && value.trim().length > 0);
}
/** Registration projection must never restore administrative or preference state. */
export function networkingProfileOverrides(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([key]) =>
    key === "consent" || (NETWORKING_PROFESSIONAL_FIELDS as readonly string[]).includes(key)));
}
export const NetworkingFieldMappingSchema = z.partialRecord(
  z.enum([
    "company",
    "jobTitle",
    "sector",
    "bio",
    "city",
    "country",
    "website",
    "photoUrl",
    "interests",
    "offers",
    "seeks",
    "consent",
  ]),
  z.string().max(200),
);
export const NetworkingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  requireSecondFactor: z.boolean().default(false),
  requiredAccessId: z.string().uuid().nullable().optional(),
  approvalMode: z.enum(["MANUAL", "AUTOMATIC"]).default("MANUAL"),
  eligiblePaymentStatuses: z
    .array(PaymentStatusSchema)
    .min(1)
    .default(["PAID", "SPONSORED", "WAIVED"]),
  swipeEnabled: z.boolean().default(true),
  searchEnabled: z.boolean().default(true),
  chatEnabled: z.boolean().default(true),
  meetingsEnabled: z.boolean().default(true),
  autoAssignTables: z.boolean().default(true),
  slotDurationMinutes: z
    .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
    .default(30),
  timezone: z
    .string()
    .default("Africa/Tunis")
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
  opensAt: instant.nullable().optional(),
  closesAt: instant.nullable().optional(),
  retentionDays: z.number().int().min(1).max(730).default(90),
  requestExpiryHours: z.number().int().min(1).max(168).default(48),
  languages: z
    .array(z.enum(["fr", "en", "ar"]))
    .min(1)
    .default(["fr", "en", "ar"]),
  defaultLanguage: z.enum(["fr", "en", "ar"]).default("fr"),
  logoUrl: nullableUrl,
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#2563eb"),
  welcomeMessage: z.string().max(2000).default(""),
  participantLabel: z.string().max(100).default("Participants"),
  tableLabel: z.string().max(100).default("Tables"),
  helpMessage: z.string().max(4000).default(""),
  uiLabels: z
    .record(
      z.string().max(100),
      z.object({
        fr: z.string().max(1000),
        en: z.string().max(1000).optional(),
        ar: z.string().max(1000).optional(),
      }),
    )
    .default({}),
  supportEmail: z.string().email().nullable().optional(),
  supportPhone: z.string().max(40).nullable().optional(),
  accessInstructions: z.string().max(4000).default(""),
  accessPlanUrl: nullableUrl,
  emailTemplates: z
    .record(
      z.string().max(100),
      z.object({
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(10000),
      }),
    )
    .default({}),
  fieldMapping: NetworkingFieldMappingSchema.default({}),
  openingHours: z
    .array(
      z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        })
        .refine((v) => v.end > v.start, "Closing time must follow opening time")
        .refine(
          (v) =>
            Number(v.start.slice(3)) % 5 === 0 &&
            Number(v.end.slice(3)) % 5 === 0,
          "Meeting opening times must use five-minute boundaries",
        ),
    )
    .max(366)
    .default([]),
  blackoutSlots: z.array(instant).max(20000).default([]),
});
const networkingConfigPatchSchema =
  NetworkingConfigSchema.partial().extend({
    expectedRevision: z.string().optional(),
    revision: z.string().optional(),
  }).strict();
// Zod 4 applies inner defaults even through partial(); a PATCH must retain only supplied keys.
export const UpdateNetworkingConfigSchema = z.unknown().transform((input, ctx) => {
  const parsed = networkingConfigPatchSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  const keys = new Set(Object.keys(input as object));
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => keys.has(key))) as z.infer<typeof networkingConfigPatchSchema>;
});
export type NetworkingConfig = z.infer<typeof NetworkingConfigSchema>;
export const NETWORKING_CONFIG_UNCONFIGURED_REVISION = "unconfigured";
export type NetworkingConfigWithRevision = NetworkingConfig & { revision: string };
export const NetworkingProfileUpdateSchema = z
  .object({
    company: z.string().trim().min(1).max(200).optional(),
    jobTitle: z.string().trim().min(1).max(200).optional(),
    sector: z.string().trim().min(1).max(120).optional(),
    bio: z.string().max(2000).optional(),
    city: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    website: nullableUrl,
    photoUrl: nullableUrl,
    interests: z.array(z.string().max(100)).max(30).optional(),
    offers: z.string().max(2000).optional(),
    seeks: z.string().max(2000).optional(),
    visible: z.boolean().optional(),
    meetingsEnabled: z.boolean().optional(),
    emailPreference: z.enum(["IMMEDIATE", "DAILY", "OFF"]).optional(),
    language: z.enum(["fr", "en", "ar"]).optional(),
    consent: z.boolean().optional(),
    resetFields: z.array(z.enum(NETWORKING_PROFESSIONAL_FIELDS)).max(11).optional(),
  })
  .strict();
export const NetworkingAdminProfileUpdateSchema =
  NetworkingProfileUpdateSchema.omit({ resetFields: true }).extend({
    status: z.enum(NETWORKING_PROFILE_STATUSES).optional(),
    featured: z.boolean().optional(),
    standTableId: id.nullable().optional(),
  }).strict();
/** Omit both fields for the one-release, unbounded legacy response. */
export const NetworkingParticipantListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export type NetworkingParticipantListQuery = z.infer<typeof NetworkingParticipantListQuerySchema>;
export const NetworkingParticipantCursorSchema = z.object({
  version: z.literal(1),
  scope: z.string().max(1024),
  at: instant,
  id,
}).strict();
export interface NetworkingParticipantPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export const NetworkingListQuerySchema = z.object({
  viewId: id.optional(),
  company: z.string().max(200).optional(),
  sectors: z.preprocess(
    (value) =>
      typeof value === "string" ? value.split(",").filter(Boolean) : value,
    z.array(z.string().max(120)).max(30).optional(),
  ),
  city: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  sector: z.string().max(120).optional(),
  status: z.string().max(30).optional(),
  activity: z
    .enum(["ALL", "VERY_ACTIVE", "ACTIVE", "INACTIVE", "MATCHED", "MEETINGS"])
    .optional(),
  sort: z.enum(["recommended", "name", "company", "recent"]).default("name"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: instant.optional(),
  beforeId: id.optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tableId: id.optional(),
});
/** Calendar uses the meeting's start date in the event timezone (same as the organizer list). */
export const NetworkingCalendarQuerySchema = NetworkingListQuerySchema.pick({ status: true, tableId: true }).extend({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }, "Invalid calendar date"),
});
export type NetworkingCalendarQuery = z.infer<typeof NetworkingCalendarQuerySchema>;

export const NetworkingOtpRequestSchema = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
  })
  .strict();
export const NetworkingOtpVerifySchema = z
  .object({ challengeId: id, code: z.string().regex(/^\d{6}$/) })
  .strict();
export const NetworkingInterestSchema = z
  .object({ profileId: id, action: z.enum(["LIKE", "PASS"]) })
  .strict();
export const NetworkingMessageSchema = z
  .object({ body: z.string().trim().min(1).max(1000), clientMessageId: id })
  .strict();
export const NetworkingBlockSchema = z.object({ profileId: id }).strict();
export const NetworkingReportSchema = z
  .object({
    profileId: id,
    messageId: id.optional(),
    reason: z.string().trim().min(5).max(2000),
  })
  .strict();
export const NetworkingReportActionSchema = z
  .object({
    action: z.enum(["DISMISS", "RESOLVE", "WARN", "SUSPEND", "EXCLUDE"]),
    note: z.string().max(2000).optional(),
  })
  .strict();
export const NetworkingAvailabilitySchema = z
  .object({ slots: z.array(instant).max(20000) })
  .strict();
export const NetworkingMeetingCreateSchema = z
  .object({
    profileId: id,
    startsAt: instant,
    message: z.string().max(1000).optional(),
  })
  .strict();
export const NetworkingMeetingRespondSchema = z
  .object({
    action: z.enum(["ACCEPT", "DECLINE", "CANCEL", "RESCHEDULE"]),
    startsAt: instant.optional(),
    message: z.string().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) => v.action !== "RESCHEDULE" || !!v.startsAt,
    "Rescheduling requires startsAt",
  );
export const NetworkingAdminMeetingUpdateSchema = z
  .object({
    action: z.enum(["ASSIGN", "CANCEL", "COMPLETED", "NO_SHOW"]),
    tableId: id.optional(),
  })
  .strict()
  .refine(
    (v) => v.action !== "ASSIGN" || !!v.tableId,
    "Assignment requires a table",
  );
export const NetworkingSpaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["TABLE", "STAND"]),
  capacity: z.number().int().min(1).max(500),
  location: z.string().trim().max(200).default(""),
  active: z.boolean().default(true),
}).strict();
const networkingSpacePatchSchema = NetworkingSpaceSchema.partial().strict();
// Preserve supplied keys: Zod 4 partial() otherwise injects create defaults.
export const NetworkingSpaceUpdateSchema = z.unknown().transform((input, ctx) => {
  const parsed = networkingSpacePatchSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  const keys = new Set(Object.keys(input as object));
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => keys.has(key))) as z.infer<typeof networkingSpacePatchSchema>;
});
export type NetworkingSpaceInput = z.infer<typeof NetworkingSpaceSchema>;
export interface NetworkingSpace extends NetworkingSpaceInput {
  id: string;
  eventId: string;
  allocatedCount?: number;
}
export const NetworkingTableSchema = z
  .object({
    spaceId: id,
    name: z.string().trim().min(1).max(120),
    capacity: z.literal(2).default(2),
    location: z.string().max(200).default(""),
    active: z.boolean().default(true),
    kind: z.enum(["TABLE", "STAND"]).default("TABLE"),
    ownerProfileId: id.nullable().optional(),
    representativeIds: z.array(id).max(500).optional(),
  })
  .strict();
const networkingTablePatchSchema = NetworkingTableSchema.partial().strict();
// Preserve supplied keys: Zod 4 partial() otherwise injects create defaults.
export const NetworkingTableUpdateSchema = z.unknown().transform((input, ctx) => {
  const parsed = networkingTablePatchSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  const keys = new Set(Object.keys(input as object));
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => keys.has(key))) as z.infer<typeof networkingTablePatchSchema>;
});
export type NetworkingTableInput = z.infer<typeof NetworkingTableSchema>;
export const NetworkingNotificationReadSchema = z
  .object({ ids: z.array(id).max(100).optional() })
  .strict();
export const NetworkingPushSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((v) => v.startsWith("https://")),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(256),
    auth: z.string().min(8).max(256),
  }),
});
export const NetworkingCheckinSchema = z
  .object({ token: z.string().min(16).max(2048) })
  .strict();
export interface NetworkingProfile {
  id: string;
  eventId: string;
  registrationId?: string;
  email?: string;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  sector: string;
  bio: string;
  city: string;
  country: string;
  website: string | null;
  photoUrl: string | null;
  interests: string[];
  offers: string;
  seeks: string;
  status?: (typeof NETWORKING_PROFILE_STATUSES)[number];
  visible: boolean;
  meetingsEnabled: boolean;
  emailPreference?: "IMMEDIATE" | "DAILY" | "OFF";
  language?: "fr" | "en" | "ar";
  lastActiveAt: string | null;
  featured: boolean;
  standTableId?: string | null;
  createdAt: string;
  updatedAt: string;
  consent?: boolean;
}
export interface NetworkingTable {
  id: string;
  eventId: string;
  spaceId?: string | null;
  space?: NetworkingSpace | null;
  representativeIds?: string[];
  name: string;
  capacity: number;
  location: string;
  active: boolean;
  kind: "TABLE" | "STAND";
  ownerProfileId: string | null;
}
export interface NetworkingMessage {
  id: string;
  connectionId: string;
  senderId: string;
  body: string;
  createdAt: string;
}
export interface NetworkingConnection {
  id: string;
  profile: NetworkingProfile;
  lastMessage: NetworkingMessage | null;
  unreadCount: number;
  createdAt: string;
}
export interface NetworkingMeeting {
  id: string;
  eventId: string;
  requesterId: string;
  recipientId: string;
  requester: NetworkingProfile | null;
  recipient: NetworkingProfile | null;
  startsAt: string;
  endsAt: string;
  tableId: string | null;
  table: NetworkingTable | null;
  status: (typeof NETWORKING_MEETING_STATUSES)[number];
  message: string;
  cancellationNote?: string;
  proposedStartsAt: string | null;
  proposalBy: string | null;
  revision: number;
  createdAt: string;
  requesterCheckedInAt?: string | null;
  recipientCheckedInAt?: string | null;
}
export interface NetworkingNotification {
  data?: Record<string, unknown>;
  id: string;
  type: string;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
}
export interface NetworkingModerationReport {
  id: string;
  eventId: string;
  reporterId: string;
  profileId: string;
  reporter: NetworkingProfile;
  profile: NetworkingProfile;
  message: NetworkingMessage | null;
  reason: string;
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  note: string | null;
  resolvedBy: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}
export interface NetworkingAnalytics {
  emailSent?: number;
  emailDelivered?: number;
  emailOpened?: number;
  emailClicked?: number;
  emailFailed?: number;
  profileViews: number;
  activationRate: number;
  conversations: number;
  responseRate: number;
  meetingConversionRate: number;
  profiles: number;
  activeProfiles: number;
  visibleProfiles: number;
  likes: number;
  passes: number;
  matches: number;
  matchRate: number;
  messages: number;
  meetings: number;
  confirmedMeetings: number;
  completedMeetings: number;
  cancelledMeetings: number;
  noShowMeetings: number;
  pendingMeetings: number;
  tableOccupancyRate: number;
  reports: number;
  hourlyActivity?: Array<{ hour: string; activity: number }>;
  timeSeries: Array<{
    date: string;
    bookingRequests?: number;
    matches: number;
    messages: number;
    meetings: number;
  }>;
  sectors: Array<{
    sector: string;
    participants: number;
    matches: number;
    meetings: number;
  }>;
  engagement: Array<{
    profileId: string;
    name: string;
    matches: number;
    messages: number;
    meetings: number;
  }>;
}
export interface NetworkingList<T> {
  items: T[];
  total: number;
}
export interface NetworkingPublicConfig {
  pushPublicKey?: string | null;
  networkingUrl?: string;
  event: {
    id: string;
    name: string;
    slug: string;
    startsAt: string;
    endsAt: string;
    location: string | null;
    bannerUrl: string | null;
  };
  config: Omit<
    NetworkingConfig,
    "eligiblePaymentStatuses" | "retentionDays" | "emailTemplates"
  >;
}

export const NetworkingMfaCodeSchema = z
  .object({ code: z.string().trim().min(6).max(64) })
  .strict();

export const NetworkingBadgeVerifySchema = z
  .object({
    token: z.string().min(16).max(2048),
    accessId: z.string().uuid().optional(),
  })
  .strict();

export interface NetworkingPersonalAnalytics {
  currentEventId: string;
  events: Array<{
    eventId: string;
    eventName: string;
    startsAt: string;
    endsAt: string;
    profileViews: number;
    matches: number;
    sentMessages: number;
    plannedMeetings: number;
    completedMeetings: number;
  }>;
}

/** Recency tiers used by organizer filters: 24 hours, seven days, or older/no activity. */
export function networkingActivity(lastActiveAt: Date | string | null, now = Date.now()) {
  const age = lastActiveAt ? now - new Date(lastActiveAt).getTime() : Infinity;
  return age <= 86_400_000 ? "VERY_ACTIVE" : age <= 7 * 86_400_000 ? "ACTIVE" : "INACTIVE";
}

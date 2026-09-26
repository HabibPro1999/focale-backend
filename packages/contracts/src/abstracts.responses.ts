import { z } from "zod";
import { ABSTRACT_STATUSES, ABSTRACT_FINAL_TYPES } from "./abstracts";

// ============================================================================
// Response contracts (plan 5.5) for the public abstracts routes: the author's
// submission pages and the committee invite links. The API projects every
// response onto its contract, so a field that is not listed here never leaves
// the server. Every date is already an ISO 8601 string in these payloads.
// The abstract `content`, `coAuthors` and `additionalFieldsData`, the config's
// `languages` and additional-field definitions, and theme `translations` are
// JSON documents the server stores as given; they stay opaque (plan 5.2).
// ============================================================================

const AbstractRequestedTypeSchema = z.enum(["ORAL_COMMUNICATION", "POSTER"]);

const IsoDateTimeSchema = z.string();

/**
 * GET /api/public/events/:slug/abstracts/config: what the submission page
 * needs. `{ enabled: false }` alone when the event has no abstracts config.
 */
export const PublicAbstractConfigResponseSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    acceptingSubmissions: z.boolean(),
    eventId: z.string(),
    eventName: z.string(),
    /** Same as `eventName`, kept for older form-app builds. */
    congressName: z.string(),
    submissionMode: z.enum(["FREE_TEXT", "STRUCTURED"]),
    globalWordLimit: z.number().nullable(),
    maxThemesPerAbstract: z.number().nullable(),
    languages: z.unknown(),
    sectionWordLimits: z.object({
      introduction: z.number().nullable(),
      objective: z.number().nullable(),
      methods: z.number().nullable(),
      results: z.number().nullable(),
      conclusion: z.number().nullable(),
    }),
    themes: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        translations: z.unknown(),
      }),
    ),
    requestedTypes: z.array(
      z.object({ value: AbstractRequestedTypeSchema, label: z.string() }),
    ),
    additionalFields: z.object({ fields: z.array(z.unknown()) }),
    deadlines: z.object({
      submissionStart: IsoDateTimeSchema.nullable(),
      submission: IsoDateTimeSchema.nullable(),
      editing: IsoDateTimeSchema.nullable(),
      scoringStart: IsoDateTimeSchema.nullable(),
      finalFile: IsoDateTimeSchema.nullable(),
    }),
    editingEnabled: z.boolean(),
    finalFileUploadEnabled: z.boolean(),
  }),
]);

/**
 * POST /api/public/events/:slug/abstracts/submit. `token` is the author's own
 * edit token; `statusUrl` embeds it.
 */
export const AbstractSubmittedResponseSchema = z.object({
  id: z.string(),
  token: z.string(),
  status: z.literal("SUBMITTED"),
  createdAt: IsoDateTimeSchema,
  statusUrl: z.string(),
});

/**
 * The author's view of an abstract, read with its edit token:
 * GET /api/public/abstracts/:id, and the result of PATCH /api/public/abstracts/:id
 * and POST /api/public/abstracts/:id/final-file.
 */
export const PublicAbstractResponseSchema = z.object({
  id: z.string(),
  status: z.enum(ABSTRACT_STATUSES),
  code: z.string().nullable(),
  authorFirstName: z.string(),
  authorLastName: z.string(),
  authorAffiliation: z.string().nullable(),
  authorEmail: z.string(),
  authorPhone: z.string(),
  coAuthors: z.unknown(),
  requestedType: AbstractRequestedTypeSchema,
  finalType: z.enum(ABSTRACT_FINAL_TYPES).nullable(),
  themes: z.array(z.object({ id: z.string(), label: z.string() })),
  content: z.unknown(),
  additionalFieldsData: z.unknown(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastEditedAt: IsoDateTimeSchema.nullable(),
  editing: z.object({
    allowed: z.boolean(),
    deadline: IsoDateTimeSchema.nullable(),
  }),
  finalFile: z.object({
    enabled: z.boolean(),
    deadline: IsoDateTimeSchema.nullable(),
    kind: z.enum(["PDF", "PPT", "PPTX"]).nullable(),
    size: z.number().nullable(),
    uploadedAt: IsoDateTimeSchema.nullable(),
    uploaded: z.boolean(),
  }),
});

// ============================================================================
// Committee invite links (POST /api/public/committee/invite/*)
// ============================================================================

/** POST …/verify: who the invite is for, before the member sets a password. */
export const CommitteeInviteVerifyResponseSchema = z.object({
  email: z.string(),
  name: z.string(),
  eventName: z.string(),
});

/** POST …/set-password: the account now signs in with this email. */
export const CommitteeInvitePasswordSetResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string(),
});

/** POST …/resend: always `{ ok: true }`, whether or not an email was sent. */
export const CommitteeInviteResendResponseSchema = z.object({
  ok: z.literal(true),
});

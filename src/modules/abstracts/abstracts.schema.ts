import { z } from "zod";
import { FormFieldSchema } from "@modules/forms/forms.schema.js";

// ============================================================================
// Param Schemas
// ============================================================================

export const AbstractsEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const ThemeIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  themeId: z.string().uuid(),
});


export const AbstractAdminParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  abstractId: z.string().uuid(),
});

export const AbstractBookJobParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  jobId: z.string().uuid(),
});
// ============================================================================
// Config Schemas
// ============================================================================

const SectionWordLimitsSchema = z.strictObject({
  introduction: z.number().int().min(0).optional(),
  objective: z.number().int().min(0).optional(),
  methods: z.number().int().min(0).optional(),
  results: z.number().int().min(0).optional(),
  conclusion: z.number().int().min(0).optional(),
});

const NullableDateTime = z
  .union([z.string().datetime(), z.null()])
  .optional();

export const PatchConfigSchema = z.strictObject({
  submissionMode: z.enum(["FREE_TEXT", "STRUCTURED"]).optional(),
  globalWordLimit: z.union([z.number().int().min(0), z.null()]).optional(),
  sectionWordLimits: SectionWordLimitsSchema.optional(),
  submissionDeadline: NullableDateTime,
  editingDeadline: NullableDateTime,
  scoringDeadline: NullableDateTime,
  finalFileDeadline: NullableDateTime,
  editingEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  commentsSentToAuthor: z.boolean().optional(),
  finalFileUploadEnabled: z.boolean().optional(),
  reviewersPerAbstract: z.number().int().min(1).max(10).optional(),
  divergenceThreshold: z.number().int().min(0).max(20).optional(),
  distributeByTheme: z.boolean().optional(),
  bookFontFamily: z.string().min(1).max(100).optional(),
  bookFontSize: z.number().int().min(6).max(72).optional(),
  bookLineSpacing: z.number().min(1.0).max(3.0).optional(),
  bookOrder: z
    .enum(["BY_CODE", "BY_THEME", "BY_SUBMISSION_ORDER"])
    .optional(),
  bookIncludeAuthorNames: z.boolean().optional(),
  force: z.boolean().optional(),
});

// ============================================================================
// Theme Schemas
// ============================================================================

export const CreateThemeSchema = z.strictObject({
  label: z.string().min(1).max(120),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const UpdateThemeSchema = z.strictObject({
  label: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

// ============================================================================
// Additional Fields Schemas
// ============================================================================

export const AdditionalFieldsSchema = z.strictObject({
  fields: z.array(FormFieldSchema).max(50),
});

// ============================================================================
// Types
// ============================================================================

export type PatchConfigInput = z.infer<typeof PatchConfigSchema>;
export type CreateThemeInput = z.infer<typeof CreateThemeSchema>;
export type UpdateThemeInput = z.infer<typeof UpdateThemeSchema>;
export type AdditionalFieldsInput = z.infer<typeof AdditionalFieldsSchema>;


// ============================================================================
// Public Submission Schemas
// ============================================================================

export const EventSlugParamSchema = z.strictObject({
  slug: z.string().min(1),
});

export const AbstractIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const AbstractTokenQuerySchema = z.strictObject({
  token: z.string().length(64).optional(),
});

const CoAuthorSchema = z.strictObject({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  affiliation: z.string().max(200).optional(),
});

const FreeTextContentSchema = z.strictObject({
  mode: z.literal("FREE_TEXT"),
  title: z.string().min(1).max(300),
  body: z.string().min(1),
});

const StructuredContentSchema = z.strictObject({
  mode: z.literal("STRUCTURED"),
  title: z.string().min(1).max(300),
  introduction: z.string().min(1),
  objective: z.string().min(1),
  methods: z.string().min(1),
  results: z.string().min(1),
  conclusion: z.string().min(1),
});

export const SubmitAbstractSchema = z.strictObject({
  authorFirstName: z.string().min(1).max(80),
  authorLastName: z.string().min(1).max(80),
  authorEmail: z.string().email(),
  authorPhone: z.string().min(1).max(40),
  coAuthors: z.array(CoAuthorSchema).max(20).default([]),
  requestedType: z.enum(["ORAL_COMMUNICATION", "POSTER"]),
  themeIds: z.array(z.string().uuid()).min(1),
  content: z.discriminatedUnion("mode", [
    FreeTextContentSchema,
    StructuredContentSchema,
  ]),
  additionalFieldsData: z.record(z.string(), z.unknown()).default({}),
  registrationId: z.string().uuid().nullish(),
  linkBaseUrl: z.string().url(),
});

export type SubmitAbstractInput = z.infer<typeof SubmitAbstractSchema>;


// ============================================================================
// Admin Abstract Schemas
// ============================================================================

export const ListAbstractsQuerySchema = z.strictObject({
  status: z
    .enum(["SUBMITTED", "UNDER_REVIEW", "REVIEW_COMPLETE", "ACCEPTED", "REJECTED", "PENDING"])
    .optional(),
  themeId: z.string().uuid().optional(),
  reviewerId: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const FinalizeAbstractSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("ACCEPTED"),
    finalType: z.enum(["ORAL_COMMUNICATION", "POSTER"]),
  }),
  z.strictObject({
    decision: z.enum(["REJECTED", "PENDING"]),
    finalType: z.enum(["ORAL_COMMUNICATION", "POSTER"]).optional(),
  }),
]);

export type ListAbstractsQuery = z.infer<typeof ListAbstractsQuerySchema>;
export type FinalizeAbstractInput = z.infer<typeof FinalizeAbstractSchema>;
// ============================================================================
// Committee Schemas
// ============================================================================

export const CommitteeMemberUserParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  userId: z.string().min(1),
});

export const AssignAbstractParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  abstractId: z.string().uuid(),
});

export const ExistingCommitteeMemberSchema = z.strictObject({
  userId: z.string().min(1),
});

export const NewCommitteeMemberSchema = z.strictObject({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(
      /[^a-zA-Z0-9]/,
      "Password must contain at least one special character",
    ),
});

export const AddCommitteeMemberSchema = z.union([
  ExistingCommitteeMemberSchema,
  NewCommitteeMemberSchema,
]);

export const SetReviewerThemesSchema = z.strictObject({
  themeIds: z.array(z.string().uuid()),
});

export const AssignReviewersSchema = z.strictObject({
  reviewerIds: z.array(z.string().min(1)),
});

export const CommitteeAbstractsQuerySchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const ReviewAbstractSchema = z.strictObject({
  score: z
    .number()
    .min(0)
    .max(20)
    .refine((value) => Number.isInteger(value * 2), {
      message: "Score must be a multiple of 0.5",
    }),
  comment: z.string().max(5000).nullish(),
});

export type AddCommitteeMemberInput = z.infer<typeof AddCommitteeMemberSchema>;
export type SetReviewerThemesInput = z.infer<typeof SetReviewerThemesSchema>;
export type AssignReviewersInput = z.infer<typeof AssignReviewersSchema>;
export type CommitteeAbstractsQuery = z.infer<typeof CommitteeAbstractsQuerySchema>;
export type ReviewAbstractInput = z.infer<typeof ReviewAbstractSchema>;
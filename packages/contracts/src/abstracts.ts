import { z } from "zod";
import { FormFieldSchema } from "./forms";
import { StrongPasswordSchema } from "./identity";

// ============================================================================
// Enum value unions (mirror the DB pg enums; kept as string literals so the
// contracts package stays free of a drizzle dependency).
// ============================================================================

export const ABSTRACT_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "REVIEW_COMPLETE",
  "ACCEPTED",
  "REJECTED",
  "PENDING",
] as const;
export type AbstractStatus = (typeof ABSTRACT_STATUSES)[number];

/** Statuses in which a public author may no longer edit (PENDING is editable). */
export const NON_EDITABLE_STATUSES: AbstractStatus[] = ["ACCEPTED", "REJECTED"];

/** Terminal decision statuses — finalize is blocked while in these; reopen requires one. */
export const FINAL_STATUSES: AbstractStatus[] = [
  "ACCEPTED",
  "REJECTED",
  "PENDING",
];

export const ABSTRACT_FINAL_TYPES = [
  "CONFERENCE",
  "ORAL_COMMUNICATION",
  "POSTER",
] as const;
export type AbstractFinalType = (typeof ABSTRACT_FINAL_TYPES)[number];

/** Code-string prefix per final type: e.g. `OC1-01`, `PC2-03`. */
export const CODE_SUFFIX: Record<AbstractFinalType, string> = {
  CONFERENCE: "CONF",
  ORAL_COMMUNICATION: "OC",
  POSTER: "PC",
};

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
  introduction: z.union([z.number().int().min(0), z.null()]).optional(),
  objective: z.union([z.number().int().min(0), z.null()]).optional(),
  methods: z.union([z.number().int().min(0), z.null()]).optional(),
  results: z.union([z.number().int().min(0), z.null()]).optional(),
  conclusion: z.union([z.number().int().min(0), z.null()]).optional(),
});

const NullableDateTime = z.union([z.string().datetime(), z.null()]).optional();

export const PatchConfigSchema = z.strictObject({
  submissionMode: z.enum(["FREE_TEXT", "STRUCTURED"]).optional(),
  globalWordLimit: z.union([z.number().int().min(0), z.null()]).optional(),
  sectionWordLimits: SectionWordLimitsSchema.optional(),
  submissionStartAt: NullableDateTime,
  submissionDeadline: NullableDateTime,
  editingDeadline: NullableDateTime,
  scoringStartAt: NullableDateTime,
  scoringDeadline: NullableDateTime,
  finalFileDeadline: NullableDateTime,
  editingEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  commentsSentToAuthor: z.boolean().optional(),
  finalFileUploadEnabled: z.boolean().optional(),
  reviewersPerAbstract: z.number().int().min(1).max(10).optional(),
  divergenceThreshold: z.number().int().min(0).max(20).optional(),
  maxThemesPerAbstract: z
    .union([z.number().int().min(1).max(20), z.null()])
    .optional(),
  distributeByTheme: z.boolean().optional(),
  bookFontFamily: z.string().min(1).max(100).optional(),
  bookFontSize: z.number().int().min(6).max(72).optional(),
  bookLineSpacing: z.number().min(1.0).max(3.0).optional(),
  bookOrder: z.enum(["BY_CODE", "BY_THEME", "BY_SUBMISSION_ORDER"]).optional(),
  bookIncludeAuthorNames: z.boolean().optional(),
  force: z.boolean().optional(),
});

// ============================================================================
// Theme Schemas
// ============================================================================

export const CreateThemeSchema = z.strictObject({
  label: z.string().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const UpdateThemeSchema = z.strictObject({
  label: z.string().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullish(),
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
// Public Submission Schemas
// ============================================================================

export const AbstractSlugParamSchema = z.strictObject({
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
  // Required on both submit and edit (product decision). The DB column is
  // nullable only so legacy abstracts created before this field can still be
  // read; every new write must supply an affiliation.
  authorAffiliation: z.string().trim().min(1).max(200),
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

export const EditAbstractSchema = SubmitAbstractSchema.omit({
  linkBaseUrl: true,
}).extend({
  // Older form clients may still send this submit-only field on edit. Accept it
  // for compatibility, but the edit service intentionally ignores it.
  linkBaseUrl: z.string().url().optional(),
});

// ============================================================================
// Admin Abstract Schemas
// ============================================================================

export const ListAbstractsQuerySchema = z.strictObject({
  status: z.enum(ABSTRACT_STATUSES).optional(),
  themeId: z.string().uuid().optional(),
  reviewerId: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ============================================================================
// Types
// ============================================================================

export type PatchConfigInput = z.infer<typeof PatchConfigSchema>;
export type CreateThemeInput = z.infer<typeof CreateThemeSchema>;
export type UpdateThemeInput = z.infer<typeof UpdateThemeSchema>;
export type AdditionalFieldsInput = z.infer<typeof AdditionalFieldsSchema>;
export type SubmitAbstractInput = z.infer<typeof SubmitAbstractSchema>;
export type EditAbstractInput = z.infer<typeof EditAbstractSchema>;
export type ListAbstractsQuery = z.infer<typeof ListAbstractsQuerySchema>;

// ============================================================================
// Admin decision schemas (finalize / reopen / presented)
// ============================================================================

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
export type FinalizeAbstractInput = z.infer<typeof FinalizeAbstractSchema>;

export const MarkAbstractPresentedSchema = z.strictObject({
  presented: z.boolean(),
});
export type MarkAbstractPresentedInput = z.infer<
  typeof MarkAbstractPresentedSchema
>;

// ============================================================================
// Committee schemas
// ============================================================================

/** {eventId, userId} — userId is the Firebase UID (also User.id), not a uuid. */
export const CommitteeMemberParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  userId: z.string().min(1),
});

const ExistingCommitteeMemberSchema = z.strictObject({
  userId: z.string().min(1),
});

const NewCommitteeMemberSchema = z.strictObject({
  email: z.string().email(),
  name: z.string().min(1).max(100),
});

export const AddCommitteeMemberSchema = z.union([
  ExistingCommitteeMemberSchema,
  NewCommitteeMemberSchema,
]);
export type AddCommitteeMemberInput = z.infer<typeof AddCommitteeMemberSchema>;

export const SetReviewerThemesSchema = z.strictObject({
  themeIds: z.array(z.string().uuid()),
});
export type SetReviewerThemesInput = z.infer<typeof SetReviewerThemesSchema>;

export const AssignReviewersSchema = z.strictObject({
  reviewerIds: z.array(z.string().min(1)),
});
export type AssignReviewersInput = z.infer<typeof AssignReviewersSchema>;

export const CommitteeAbstractsQuerySchema = z.strictObject({
  eventId: z.string().uuid(),
});
export type CommitteeAbstractsQuery = z.infer<
  typeof CommitteeAbstractsQuerySchema
>;

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
export type ReviewAbstractInput = z.infer<typeof ReviewAbstractSchema>;

export const SetCommitteeMemberPasswordSchema = z.strictObject({
  password: StrongPasswordSchema,
});
export type SetCommitteeMemberPasswordInput = z.infer<
  typeof SetCommitteeMemberPasswordSchema
>;

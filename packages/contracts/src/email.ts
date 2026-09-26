import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

export const EmailTemplateCategorySchema = z.enum(["AUTOMATIC", "MANUAL"]);

export const AutomaticEmailTriggerSchema = z.enum([
  "REGISTRATION_CREATED",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_CONFIRMED",
  "SPONSORSHIP_BATCH_SUBMITTED",
  "SPONSORSHIP_LINKED",
  "SPONSORSHIP_APPLIED",
  "SPONSORSHIP_PARTIAL",
  "CERTIFICATE_SENT",
]);

export const AbstractEmailTriggerSchema = z.enum([
  "ABSTRACT_SUBMISSION_ACK",
  "ABSTRACT_EDIT_ACK",
  "ABSTRACT_DECISION",
  "ABSTRACT_ACCEPTED",
  "ABSTRACT_REJECTED",
  "ABSTRACT_COMMITTEE_INVITE",
  "ABSTRACT_COMMITTEE_COMMENTS",
  "ABSTRACT_SCORE_DIVERGENCE",
  "ABSTRACT_FINAL_FILE_REQUEST",
]);

export const EmailStatusSchema = z.enum([
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
  "BOUNCED",
  "DROPPED",
  "FAILED",
  "SKIPPED",
  // 3.6: the provider call may have gone through but was never confirmed. Not
  // resent automatically; a webhook moves it forward, or an admin resends it.
  "UNCERTAIN",
]);

// ============================================================================
// Tiptap Document Schema (recursive)
// ============================================================================

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export type EmailTextAlign = "left" | "center" | "right" | "justify";

export interface TiptapNodeAttributes {
  textAlign?: EmailTextAlign | null;
  fontSize?: string | null;
  lineHeight?: string | null;
  [key: string]: unknown;
}

export interface TiptapNode {
  type: string;
  attrs?: TiptapNodeAttributes;
  marks?: TiptapMark[];
  content?: TiptapNode[];
  text?: string;
}

export interface TiptapDocument {
  type: "doc";
  content: TiptapNode[];
}

export const TiptapMarkSchema = z.strictObject({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

export const EmailTextAlignSchema = z.enum([
  "left",
  "center",
  "right",
  "justify",
]);

const CSS_LENGTH_PATTERN =
  /^(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|pc|in|cm|mm|em|rem|ex|ch|vw|vh|vmin|vmax|%)?)$/i;
const UNIT_LESS_NUMBER_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function cssLengthSchema(normalizeUnitless: boolean) {
  return z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().regex(CSS_LENGTH_PATTERN))
    .transform((value) =>
      normalizeUnitless && UNIT_LESS_NUMBER_PATTERN.test(value)
        ? `${value}px`
        : value,
    );
}

/** Unitless legacy font sizes mean pixels. */
export const EmailFontSizeSchema = cssLengthSchema(true);

/** Unitless line-height is a multiplier and must remain unitless. */
export const EmailLineHeightSchema = cssLengthSchema(false);

export const TiptapNodeAttributesSchema = z
  .object({
    // Tiptap serializes unset extension attributes as null.
    textAlign: EmailTextAlignSchema.nullable().optional(),
    fontSize: EmailFontSizeSchema.nullable().optional(),
    lineHeight: EmailLineHeightSchema.nullable().optional(),
  })
  .catchall(z.unknown());

export const TiptapNodeSchema: z.ZodType<TiptapNode> = z.lazy(() =>
  z.strictObject({
    type: z.string(),
    attrs: TiptapNodeAttributesSchema.optional(),
    marks: z.array(TiptapMarkSchema).optional(),
    content: z.array(TiptapNodeSchema).optional(),
    text: z.string().optional(),
  }),
);

export const TiptapDocumentSchema = z.strictObject({
  type: z.literal("doc"),
  content: z.array(TiptapNodeSchema),
});

// ============================================================================
// Email Template Schemas
// ============================================================================

const triggerXorRefine = (data: {
  category: "AUTOMATIC" | "MANUAL";
  trigger?: unknown;
  abstractTrigger?: unknown;
}): boolean => {
  const hasTrigger = data.trigger != null;
  const hasAbstractTrigger = data.abstractTrigger != null;
  if (data.category === "AUTOMATIC") {
    return hasTrigger !== hasAbstractTrigger;
  }
  return !hasTrigger && !hasAbstractTrigger;
};

const triggerXorMessage = {
  message:
    "Automatic templates require exactly one trigger; manual templates should not have triggers",
  path: ["trigger"],
};

const emailTemplateBaseShape = {
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  subject: z.string().min(1).max(500),
  content: TiptapDocumentSchema,
  category: EmailTemplateCategorySchema,
  trigger: AutomaticEmailTriggerSchema.optional().nullable(),
  abstractTrigger: AbstractEmailTriggerSchema.optional().nullable(),
  isActive: z.boolean().default(true),
};

/** Full create schema (includes eventId). */
export const CreateEmailTemplateSchema = z
  .strictObject({ eventId: z.string().uuid(), ...emailTemplateBaseShape })
  .refine(triggerXorRefine, triggerXorMessage);

/** Request-body schema for POST (eventId comes from the URL, not the body). */
export const CreateEmailTemplateBodySchema = z
  .strictObject(emailTemplateBaseShape)
  .refine(triggerXorRefine, triggerXorMessage);

// expectedUpdatedAt is a precondition, not itself a field to update — a body
// carrying only it has nothing to write.
const hasUpdateField = (data: Record<string, unknown>) =>
  Object.entries(data).some(
    ([key, value]) => key !== "expectedUpdatedAt" && value !== undefined,
  );

/**
 * POST /api/events/email-templates/:templateId/duplicate. The body is
 * optional (the admin app sends none; the API reads a missing body as `{}`);
 * `name` names the copy, default "<name> (Copy)".
 */
export const DuplicateEmailTemplateSchema = z.strictObject({
  name: z.string().min(1).max(255).optional(),
});

export type DuplicateEmailTemplateInput = z.infer<typeof DuplicateEmailTemplateSchema>;

export const UpdateEmailTemplateSchema = z
  .strictObject({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional().nullable(),
    subject: z.string().min(1).max(500).optional(),
    content: TiptapDocumentSchema.optional(),
    category: EmailTemplateCategorySchema.optional(),
    trigger: AutomaticEmailTriggerSchema.optional().nullable(),
    abstractTrigger: AbstractEmailTriggerSchema.optional().nullable(),
    isActive: z.boolean().optional(),
    // M11: optimistic-concurrency precondition from GET's `updatedAt`. Optional
    // for backward compatibility — omitted means last-write-wins, as before.
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

export const ListEmailTemplatesQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: EmailTemplateCategorySchema.optional(),
  trigger: AutomaticEmailTriggerSchema.optional(),
  abstractTrigger: AbstractEmailTriggerSchema.optional(),
  search: z.string().max(200).optional(),
});

// ============================================================================
// Event Email Logs Query Schema
// ============================================================================

export const ListEventEmailLogsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: EmailStatusSchema.optional(),
  trigger: AutomaticEmailTriggerSchema.optional(),
});

// ============================================================================
// Bulk Send Schema
// ============================================================================

export const BulkSendFilterSchema = z.strictObject({
  paymentStatus: z
    .array(
      z.enum([
        "PENDING",
        "VERIFYING",
        "PARTIAL",
        "PAID",
        "SPONSORED",
        "WAIVED",
        "REFUNDED",
      ]),
    )
    .optional(),
  accessTypeIds: z.array(z.string().uuid()).optional(),
  role: z
    .array(
      z.enum(["PARTICIPANT", "SPEAKER", "MODERATOR", "ORGANIZER", "INVITED"]),
    )
    .optional(),
});

export const BulkSendEmailSchema = z.strictObject({
  audience: z.enum(["registrants", "sponsors"]).default("registrants"),
  registrationIds: z.array(z.string().uuid()).optional(),
  filters: BulkSendFilterSchema.optional(),
});

// ============================================================================
// Test Send + Custom Send Schemas
// ============================================================================

export const TestSendEmailSchema = z.strictObject({
  recipientEmail: z.string().email(),
  recipientName: z.string().max(200).optional(),
});

export const SendCustomEmailSchema = z.strictObject({
  subject: z.string().min(1).max(500),
  content: TiptapDocumentSchema,
});

// ============================================================================
// Param Schemas (all strict)
// ============================================================================

// Named `Email*` to avoid colliding with events/registrations param schemas in
// the shared contracts barrel (both re-export under `export *`).
export const EmailEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const EmailTemplateIdParamSchema = z.strictObject({
  templateId: z.string().uuid(),
});

export const BulkSendParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  templateId: z.string().uuid(),
});

export const SendCustomEmailParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  registrationId: z.string().uuid(),
});

/** POST /api/events/:eventId/email-logs/:emailLogId/resend (3.6: UNCERTAIN emails only). */
export const ResendEmailLogParamSchema = z.strictObject({
  eventId: z.string().uuid(),
  emailLogId: z.string().uuid(),
});

// ============================================================================
// Types
// ============================================================================

export type EmailTemplateCategory = z.infer<typeof EmailTemplateCategorySchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type AbstractEmailTrigger = z.infer<typeof AbstractEmailTriggerSchema>;
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export type CreateEmailTemplateInput = z.infer<typeof CreateEmailTemplateSchema>;
export type CreateEmailTemplateBody = z.infer<
  typeof CreateEmailTemplateBodySchema
>;
export type UpdateEmailTemplateInput = z.infer<typeof UpdateEmailTemplateSchema>;
export type ListEmailTemplatesQuery = z.infer<
  typeof ListEmailTemplatesQuerySchema
>;
export type ListEventEmailLogsQuery = z.infer<
  typeof ListEventEmailLogsQuerySchema
>;
export type BulkSendFilter = z.infer<typeof BulkSendFilterSchema>;
export type BulkSendEmailInput = z.infer<typeof BulkSendEmailSchema>;
export type TestSendEmailInput = z.infer<typeof TestSendEmailSchema>;
export type SendCustomEmailInput = z.infer<typeof SendCustomEmailSchema>;

import { z } from "zod";
import type { TiptapNode } from "./email.types.js";

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
]);

// ============================================================================
// Tiptap Document Schema
// ============================================================================

export const TiptapMarkSchema = z
  .object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const TiptapNodeSchema: z.ZodType<TiptapNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z.array(TiptapMarkSchema).optional(),
      content: z.array(TiptapNodeSchema).optional(),
      text: z.string().optional(),
    })
    .strict(),
);

export const TiptapDocumentSchema = z
  .object({
    type: z.literal("doc"),
    content: z.array(TiptapNodeSchema),
  })
  .strict();

// ============================================================================
// Email Template Schemas
// ============================================================================

export const CreateEmailTemplateSchema = z
  .object({
    eventId: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    subject: z.string().min(1).max(500),
    content: TiptapDocumentSchema,
    category: EmailTemplateCategorySchema,
    trigger: AutomaticEmailTriggerSchema.optional().nullable(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine(
    (data) => {
      // Automatic templates must have a trigger
      if (data.category === "AUTOMATIC" && !data.trigger) {
        return false;
      }
      // Manual templates should not have a trigger
      if (data.category === "MANUAL" && data.trigger) {
        return false;
      }
      return true;
    },
    {
      message:
        "Automatic templates require a trigger; manual templates should not have a trigger",
      path: ["trigger"],
    },
  );

export const UpdateEmailTemplateSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional().nullable(),
    subject: z.string().min(1).max(500).optional(),
    content: TiptapDocumentSchema.optional(),
    category: EmailTemplateCategorySchema.optional(),
    trigger: AutomaticEmailTriggerSchema.optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const ListEmailTemplatesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    category: EmailTemplateCategorySchema.optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

// ============================================================================
// Bulk Send Schema (Simple recipient filtering)
// ============================================================================

export const BulkSendFilterSchema = z
  .object({
    paymentStatus: z
      .array(z.enum(["PENDING", "PAID", "REFUNDED", "WAIVED"]))
      .optional(),
    accessTypeIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export const BulkSendEmailSchema = z
  .object({
    // Option 1: Send to specific registrations
    registrationIds: z.array(z.string().uuid()).optional(),
    // Option 2: Send based on filters
    filters: BulkSendFilterSchema.optional(),
  })
  .strict();

// ============================================================================
// Test Send Schema
// ============================================================================

export const TestSendEmailSchema = z
  .object({
    recipientEmail: z.string().email(),
    recipientName: z.string().max(200).optional(),
  })
  .strict();

// ============================================================================
// ID Param Schemas
// ============================================================================

export const EmailTemplateIdParamSchema = z
  .object({
    templateId: z.string().uuid(),
  })
  .strict();

export const EventIdParamSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Response Schemas
// ============================================================================

export const EmailTemplateResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  eventId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  subject: z.string(),
  content: z.unknown(),
  category: EmailTemplateCategorySchema,
  trigger: AutomaticEmailTriggerSchema.nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const EmailTemplatesListResponseSchema = z.object({
  data: z.array(EmailTemplateResponseSchema),
  meta: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

// ============================================================================
// Types
// ============================================================================

export type EmailTemplateCategory = z.infer<typeof EmailTemplateCategorySchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export type TiptapMark = z.infer<typeof TiptapMarkSchema>;
export type TiptapDocument = z.infer<typeof TiptapDocumentSchema>;

export type CreateEmailTemplateInput = z.infer<
  typeof CreateEmailTemplateSchema
>;
export type UpdateEmailTemplateInput = z.infer<
  typeof UpdateEmailTemplateSchema
>;
export type ListEmailTemplatesQuery = z.infer<
  typeof ListEmailTemplatesQuerySchema
>;

export type BulkSendFilter = z.infer<typeof BulkSendFilterSchema>;
export type BulkSendEmailInput = z.infer<typeof BulkSendEmailSchema>;

export type TestSendEmailInput = z.infer<typeof TestSendEmailSchema>;

export type EmailTemplateResponse = z.infer<typeof EmailTemplateResponseSchema>;
export type EmailTemplatesListResponse = z.infer<
  typeof EmailTemplatesListResponseSchema
>;

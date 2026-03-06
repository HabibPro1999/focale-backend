import { z } from "zod";
import type { TiptapNode } from "./email.types.js";
import { listQuery } from "@shared/schemas/common.js";

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
// Types
// ============================================================================

export type EmailTemplateCategory = z.infer<typeof EmailTemplateCategorySchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export type TiptapMark = z.infer<typeof TiptapMarkSchema>;
export type TiptapDocument = z.infer<typeof TiptapDocumentSchema>;

// ============================================================================
// Route Request Schemas (from email.routes.ts)
// ============================================================================

export const ListEmailTemplatesQuerySchema = listQuery({
  category: EmailTemplateCategorySchema.optional(),
});

export type ListEmailTemplatesQuery = z.infer<
  typeof ListEmailTemplatesQuerySchema
>;

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
      if (data.category === "AUTOMATIC" && !data.trigger) return false;
      if (data.category === "MANUAL" && data.trigger) return false;
      return true;
    },
    {
      message:
        "Automatic templates require a trigger; manual templates should not have a trigger",
      path: ["trigger"],
    },
  );

export type CreateEmailTemplateInput = z.infer<typeof CreateEmailTemplateSchema>;

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

export type UpdateEmailTemplateInput = z.infer<typeof UpdateEmailTemplateSchema>;

export const BulkSendFilterSchema = z
  .object({
    paymentStatus: z
      .array(z.enum(["PENDING", "PAID", "REFUNDED", "WAIVED", "VERIFYING"]))
      .optional(),
    accessTypeIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export const BulkSendEmailSchema = z
  .object({
    registrationIds: z.array(z.string().uuid()).optional(),
    filters: BulkSendFilterSchema.optional(),
  })
  .strict();

export type BulkSendEmailInput = z.infer<typeof BulkSendEmailSchema>;

export const TestSendEmailSchema = z
  .object({
    recipientEmail: z.string().email(),
    recipientName: z.string().max(200).optional(),
  })
  .strict();

export type TestSendEmailInput = z.infer<typeof TestSendEmailSchema>;

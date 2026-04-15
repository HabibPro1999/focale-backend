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
  "CERTIFICATE_SENT",
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
  .strictObject({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  });

export const TiptapNodeSchema: z.ZodType<TiptapNode> = z.lazy(() =>
  z
    .strictObject({
      type: z.string(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z.array(TiptapMarkSchema).optional(),
      content: z.array(TiptapNodeSchema).optional(),
      text: z.string().optional(),
    }),
);

export const TiptapDocumentSchema = z
  .strictObject({
    type: z.literal("doc"),
    content: z.array(TiptapNodeSchema),
  });

// ============================================================================
// Email Template Schemas
// ============================================================================

export const CreateEmailTemplateSchema = z
  .strictObject({
    eventId: z.string().uuid(),
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    subject: z.string().min(1).max(500),
    content: TiptapDocumentSchema,
    category: EmailTemplateCategorySchema,
    trigger: AutomaticEmailTriggerSchema.optional().nullable(),
    isActive: z.boolean().default(true),
  })
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
  .strictObject({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional().nullable(),
    subject: z.string().min(1).max(500).optional(),
    content: TiptapDocumentSchema.optional(),
    category: EmailTemplateCategorySchema.optional(),
    trigger: AutomaticEmailTriggerSchema.optional().nullable(),
    isActive: z.boolean().optional(),
  });

export const ListEmailTemplatesQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    category: EmailTemplateCategorySchema.optional(),
    search: z.string().max(200).optional(),
  });

// ============================================================================
// Event Email Logs Query Schema
// ============================================================================

export const ListEventEmailLogsQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: EmailStatusSchema.optional(),
    trigger: AutomaticEmailTriggerSchema.optional(),
  });

export type ListEventEmailLogsQuery = z.infer<
  typeof ListEventEmailLogsQuerySchema
>;

// ============================================================================
// Bulk Send Schema (Simple recipient filtering)
// ============================================================================

export const BulkSendFilterSchema = z
  .strictObject({
    paymentStatus: z
      .array(z.enum(["PENDING", "VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"]))
      .optional(),
    accessTypeIds: z.array(z.string().uuid()).optional(),
    role: z
      .array(z.enum(["PARTICIPANT", "SPEAKER", "MODERATOR", "ORGANIZER"]))
      .optional(),
  });

export const BulkSendEmailSchema = z
  .strictObject({
    audience: z.enum(["registrants", "sponsors"]).default("registrants"),
    // Option 1: Send to specific registrations
    registrationIds: z.array(z.string().uuid()).optional(),
    // Option 2: Send based on filters
    filters: BulkSendFilterSchema.optional(),
  });

// ============================================================================
// Test Send Schema
// ============================================================================

export const TestSendEmailSchema = z
  .strictObject({
    recipientEmail: z.string().email(),
    recipientName: z.string().max(200).optional(),
  });

// ============================================================================
// Send Custom Email (one-off, templateless) to a specific registration
// ============================================================================

export const SendCustomEmailSchema = z
  .strictObject({
    subject: z.string().min(1).max(500),
    content: TiptapDocumentSchema,
  });

export const RegistrationIdParamSchema = z
  .strictObject({
    registrationId: z.string().uuid(),
  });

// ============================================================================
// ID Param Schemas
// ============================================================================

export const EmailTemplateIdParamSchema = z
  .strictObject({
    templateId: z.string().uuid(),
  });

export const EventIdParamSchema = z
  .strictObject({
    eventId: z.string().uuid(),
  });

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

export type SendCustomEmailInput = z.infer<typeof SendCustomEmailSchema>;

export type EmailTemplateResponse = z.infer<typeof EmailTemplateResponseSchema>;
export type EmailTemplatesListResponse = z.infer<
  typeof EmailTemplatesListResponseSchema
>;

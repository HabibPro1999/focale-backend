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
// Types
// ============================================================================

export type EmailTemplateCategory = z.infer<typeof EmailTemplateCategorySchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

export type TiptapMark = z.infer<typeof TiptapMarkSchema>;
export type TiptapDocument = z.infer<typeof TiptapDocumentSchema>;

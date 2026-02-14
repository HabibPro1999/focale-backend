import { z } from "zod";

export const SendGridWebhookBodySchema = z.array(
  z
    .object({
      email: z.string(),
      event: z.string(),
      sg_message_id: z.string().optional(),
      timestamp: z.number(),
      emailLogId: z.string().optional(),
      url: z.string().optional(),
      reason: z.string().optional(),
      type: z.string().optional(),
      status: z.string().optional(),
    })
    .passthrough(), // Allow additional SendGrid fields
);

// ============================================================================
// Reports Module - Analytics Schemas
// ============================================================================

import { z } from "zod";

// ============================================================================
// Response Schema
// ============================================================================

export const AnalyticsStatusItemSchema = z.object({
  status: z.string(),
  count: z.number(),
});

export const AnalyticsAccessItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  registeredCount: z.number(),
  maxCapacity: z.number().nullable(),
  fillPercentage: z.number().nullable(),
});

export const EventAnalyticsResponseSchema = z.object({
  eventId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  registrations: z.object({
    total: z.number(),
  }),
  payments: z.object({
    paid: z.number(),
    verifying: z.number(),
    pending: z.number(),
    waived: z.number(),
    refunded: z.number(),
  }),
  paymentMethods: z.object({
    bankTransfer: z.number(),
    online: z.number(),
    cash: z.number(),
    labSponsorship: z.number(),
    unset: z.number(),
  }),
  accessItems: z.array(AnalyticsAccessItemSchema),
  sponsorships: z.object({
    total: z.number(),
    byStatus: z.array(AnalyticsStatusItemSchema),
  }),
});

// ============================================================================
// Type Exports
// ============================================================================

export type AnalyticsStatusItem = z.infer<typeof AnalyticsStatusItemSchema>;
export type AnalyticsAccessItem = z.infer<typeof AnalyticsAccessItemSchema>;
export type EventAnalyticsResponse = z.infer<
  typeof EventAnalyticsResponseSchema
>;

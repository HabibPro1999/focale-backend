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
    partial: z.number(),
    sponsored: z.number(),
    waived: z.number(),
    refunded: z.number(),
  }),
  // Breakdown by how registrants are paying (payment method chosen at registration or on confirm)
  paymentMethods: z.object({
    bankTransfer: z.number(),
    online: z.number(),
    cash: z.number(),
    labSponsorship: z.number(),
    unset: z.number(), // registrations where no method has been selected yet
  }),
  accessItems: z.array(AnalyticsAccessItemSchema),
  sponsorships: z.object({
    total: z.number(),
    byStatus: z.array(AnalyticsStatusItemSchema),
  }),
});

// ============================================================================
// Access Registrants Drill-Down
// ============================================================================

export const AccessRegistrantSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  paymentStatus: z.string(),
  paidAmount: z.number(),
  totalAmount: z.number(),
  currency: z.string(),
  submittedAt: z.string().datetime(),
});

export const AccessRegistrantsResponseSchema = z.object({
  accessId: z.string().uuid(),
  accessName: z.string(),
  accessType: z.string(),
  total: z.number(),
  settled: z.number(),
  notSettled: z.number(),
  settledList: z.array(AccessRegistrantSchema),
  notSettledList: z.array(AccessRegistrantSchema),
});

// ============================================================================
// Type Exports
// ============================================================================

export type AnalyticsStatusItem = z.infer<typeof AnalyticsStatusItemSchema>;
export type AnalyticsAccessItem = z.infer<typeof AnalyticsAccessItemSchema>;
export type EventAnalyticsResponse = z.infer<
  typeof EventAnalyticsResponseSchema
>;
export type AccessRegistrant = z.infer<typeof AccessRegistrantSchema>;
export type AccessRegistrantsResponse = z.infer<
  typeof AccessRegistrantsResponseSchema
>;

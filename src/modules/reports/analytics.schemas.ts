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
  sponsorshipCoverage: z.object({
    fullySponsored: z.number(),
    partiallySponsored: z.number(),
    notSponsored: z.number(),
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

// ============================================================================
// Access Registrants Schemas
// ============================================================================

export const AccessRegistrantSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  paymentStatus: z.enum(["PENDING", "VERIFYING", "PAID", "REFUNDED", "WAIVED"]),
  paidAmount: z.number().int(),
  totalAmount: z.number().int(),
  currency: z.string(),
  submittedAt: z.string().datetime(),
});

export const AccessRegistrantsResponseSchema = z.object({
  accessId: z.string().uuid(),
  accessName: z.string(),
  accessType: z.string(),
  total: z.number().int(),
  settled: z.number().int(), // count of PAID + WAIVED
  notSettled: z.number().int(), // count of all others
  settledList: z.array(AccessRegistrantSchema),
  notSettledList: z.array(AccessRegistrantSchema),
});

export type AccessRegistrant = z.infer<typeof AccessRegistrantSchema>;
export type AccessRegistrantsResponse = z.infer<
  typeof AccessRegistrantsResponseSchema
>;

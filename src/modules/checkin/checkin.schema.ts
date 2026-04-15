import { z } from "zod";

// ============================================================================
// Request Schemas
// ============================================================================

export const CheckInBodySchema = z.strictObject({
  registrationId: z.string().uuid(),
  accessId: z.string().uuid().optional(),
});

export const BatchSyncBodySchema = z.strictObject({
  checkIns: z.array(
    z.strictObject({
      registrationId: z.string().uuid(),
      accessId: z.string().uuid().optional(),
      scannedAt: z.string().datetime(),
    }),
  ),
});

// ============================================================================
// Param Schemas
// ============================================================================

export const CheckInEventParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

// ============================================================================
// Query Schemas
// ============================================================================

export const CheckInRegistrationsQuerySchema = z.strictObject({
  accessId: z.string().uuid().optional(),
});

// ============================================================================
// Types
// ============================================================================

export type CheckInBody = z.infer<typeof CheckInBodySchema>;
export type BatchSyncBody = z.infer<typeof BatchSyncBodySchema>;
export type CheckInRegistrationsQuery = z.infer<typeof CheckInRegistrationsQuerySchema>;

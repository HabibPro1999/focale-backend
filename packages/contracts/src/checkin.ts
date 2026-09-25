import { z } from "zod";

// ============================================================================
// Request schemas (ported verbatim from src/modules/checkin/checkin.schema.ts —
// z.strictObject throughout; unknown/extra keys are rejected).
// ============================================================================

export const CheckInBodySchema = z.strictObject({
  registrationId: z.string().uuid(),
  accessId: z.string().uuid().optional(),
});

/** Most offline check-ins one sync request may carry (more → 400). */
export const MAX_CHECK_IN_SYNC_ITEMS = 500;

export const BatchSyncBodySchema = z.strictObject({
  checkIns: z
    .array(
      z.strictObject({
        registrationId: z.string().uuid(),
        accessId: z.string().uuid().optional(),
        scannedAt: z.string().datetime(),
      }),
    )
    .max(MAX_CHECK_IN_SYNC_ITEMS),
});

// Param schema. Named distinct from other modules' event-id param schemas to
// avoid a barrel clash.
export const CheckInEventParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const CheckInRegistrationsQuerySchema = z.strictObject({
  accessId: z.string().uuid().optional(),
});

// ============================================================================
// Types
// ============================================================================

export type CheckInBody = z.infer<typeof CheckInBodySchema>;
export type BatchSyncBody = z.infer<typeof BatchSyncBodySchema>;
export type CheckInRegistrationsQuery = z.infer<
  typeof CheckInRegistrationsQuerySchema
>;

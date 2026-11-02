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

/** GET /api/events/:eventId/checkin/stats. Counts are JSON numbers on every engine. */
export const CheckInStatsResponseSchema = z.object({
  total: z.number().int().min(0),
  checkedIn: z.number().int().min(0),
  byAccess: z.array(z.object({
    accessId: z.string(), name: z.string(), type: z.string(),
    total: z.number().int().min(0), checkedIn: z.number().int().min(0),
  })),
});
export type CheckInStatsResponse = z.infer<typeof CheckInStatsResponseSchema>;

/** POST /api/events/:eventId/checkin/undo. Supply the original timestamp for stale-undo protection. */
export const UndoCheckInBodySchema = CheckInBodySchema.extend({
  expectedCheckedInAt: z.string().datetime().optional(),
});
export const UndoCheckInResultSchema = z.object({ outcome: z.enum(["UNDONE", "ALREADY_UNDONE"]) });
export type UndoCheckInBody = z.infer<typeof UndoCheckInBodySchema>;

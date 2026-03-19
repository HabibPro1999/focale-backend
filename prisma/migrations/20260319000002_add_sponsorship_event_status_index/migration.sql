-- CreateIndex: Compound index on sponsorships(event_id, status)
-- Replaces relying on two separate single-column indexes for the common query pattern:
--   WHERE event_id = ? AND status = 'PENDING'
-- Used by: sponsorships.service.ts getAvailableSponsorships, pricing.service.ts validateSponsorshipCode
-- Online schema change: no table lock, no downtime.
CREATE INDEX "sponsorships_event_id_status_idx" ON "sponsorships" ("event_id", "status");

-- DropIndex: Remove redundant single-column index on code.
-- The @unique constraint on sponsorships.code already creates a unique index,
-- making this additional index redundant (extra write overhead with no query benefit).
DROP INDEX IF EXISTS "sponsorships_code_idx";

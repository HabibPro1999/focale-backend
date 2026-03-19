-- CreateIndex: Inverted index on registrations.access_type_ids
-- CockroachDB inverted indexes accelerate array containment queries (e.g. has, hasSome).
-- Used by: access.service.ts deleteEventAccess (registration.count where accessTypeIds has id)
-- Online schema change: no table lock, no downtime, background index backfill.
CREATE INVERTED INDEX "registrations_access_type_ids_inverted_idx"
  ON "registrations" ("access_type_ids");

-- Align production and development schema drift with the current Prisma schema.
-- These changes are idempotent and preserve existing rows.

ALTER TYPE "RegistrationRole" ADD VALUE IF NOT EXISTS 'INVITED';

ALTER TABLE "access_check_ins"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;

ALTER TABLE "access_check_ins"
  ALTER COLUMN "checked_in_at" SET DATA TYPE TIMESTAMPTZ;

ALTER TABLE "registrations"
  ALTER COLUMN "checked_in_at" SET DATA TYPE TIMESTAMPTZ;

UPDATE "registrations"
SET "dropped_access_ids" = ARRAY[]::STRING[]
WHERE "dropped_access_ids" IS NULL;

ALTER TABLE "registrations"
  ALTER COLUMN "dropped_access_ids" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "event_access_event_id_type_active_idx"
  ON "event_access"("event_id", "type", "active");

CREATE INDEX IF NOT EXISTS "sponsorships_batch_id_status_idx"
  ON "sponsorships"("batch_id", "status");

CREATE INDEX IF NOT EXISTS "users_client_id_role_idx"
  ON "users"("client_id", "role");

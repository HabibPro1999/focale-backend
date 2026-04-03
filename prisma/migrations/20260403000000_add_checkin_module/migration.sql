-- Add event-level check-in columns to registrations (nullable, no data loss)
ALTER TABLE "registrations" ADD COLUMN "checked_in_at" TIMESTAMPTZ;
ALTER TABLE "registrations" ADD COLUMN "checked_in_by" TEXT;

-- Create access-level check-in table
CREATE TABLE "access_check_ins" (
    "id" STRING NOT NULL DEFAULT gen_random_uuid(),
    "registration_id" STRING NOT NULL,
    "access_id" STRING NOT NULL,
    "checked_in_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "checked_in_by" STRING NOT NULL,

    CONSTRAINT "access_check_ins_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one check-in per registration per access item
CREATE UNIQUE INDEX "access_check_ins_registration_id_access_id_key" ON "access_check_ins"("registration_id", "access_id");

-- Index for querying check-ins by access item
CREATE INDEX "access_check_ins_access_id_idx" ON "access_check_ins"("access_id");

-- Foreign keys
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

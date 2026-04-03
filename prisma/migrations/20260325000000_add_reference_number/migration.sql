-- AlterTable
ALTER TABLE "registrations" ADD COLUMN "reference_number" STRING;

-- Backfill existing rows with a reference number derived from their ID
UPDATE "registrations" SET "reference_number" = 'REG-' || UPPER(SUBSTRING(id::text, 1, 8)) WHERE "reference_number" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "registrations_reference_number_key" ON "registrations"("reference_number");

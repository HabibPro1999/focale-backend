-- AlterTable
ALTER TABLE "sponsorships" ADD COLUMN "target_registration_id" STRING;

-- CreateIndex
CREATE INDEX "sponsorships_target_registration_id_idx" ON "sponsorships"("target_registration_id");

-- AlterTable: Add banner URL to events
ALTER TABLE "events" ADD COLUMN "banner_url" STRING;

-- AlterTable: Add target registration ID to sponsorships (for pending linked-account approval)
ALTER TABLE "sponsorships" ADD COLUMN "target_registration_id" STRING;

-- CreateIndex
CREATE INDEX "sponsorships_target_registration_id_idx" ON "sponsorships"("target_registration_id");

-- CreateEnum
CREATE TYPE "AbstractBookJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "abstract_book_jobs" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "requested_by" STRING NOT NULL,
    "status" "AbstractBookJobStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" STRING,
    "error_message" STRING,
    "included_count" INT4 NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_book_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "abstract_book_jobs_event_id_created_at_idx" ON "abstract_book_jobs"("event_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "abstract_book_jobs_status_created_at_idx" ON "abstract_book_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "abstract_book_jobs" ADD CONSTRAINT "abstract_book_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

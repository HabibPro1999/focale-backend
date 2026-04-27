-- CreateTable
CREATE TABLE "abstract_code_counters" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "last_value" INT4 NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abstract_code_counters_event_id_key" ON "abstract_code_counters"("event_id");

-- AddForeignKey
ALTER TABLE "abstract_code_counters" ADD CONSTRAINT "abstract_code_counters_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

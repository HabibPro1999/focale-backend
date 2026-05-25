-- TSHG abstract requirements: windows, single-theme config, /25 scoring,
-- conference final type, scoped code counters, normalized author email, and
-- presentation tracking.

ALTER TYPE "AbstractFinalType" ADD VALUE 'CONFERENCE';

ALTER TABLE "abstract_config"
  ADD COLUMN IF NOT EXISTS "submission_start_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "scoring_start_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "max_themes_per_abstract" INT4;

ALTER TABLE "abstracts"
  ADD COLUMN IF NOT EXISTS "author_email_normalized" STRING,
  ADD COLUMN IF NOT EXISTS "presented_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "presented_by" STRING;

UPDATE "abstracts"
SET "author_email_normalized" = lower(trim("author_email"))
WHERE "author_email_normalized" IS NULL;

DROP INDEX IF EXISTS "abstracts_event_id_code_number_key";

CREATE INDEX IF NOT EXISTS "abstracts_event_id_author_email_normalized_idx"
  ON "abstracts"("event_id", "author_email_normalized");

-- Existing counter rows only cache the next numeric value. Codes already stored
-- on accepted abstracts remain intact, and the new allocator seeds scoped
-- counters from accepted rows when a scope is first used.
DROP TABLE IF EXISTS "abstract_code_counters";

CREATE TABLE "abstract_code_counters" (
  "id" STRING NOT NULL,
  "event_id" STRING NOT NULL,
  "theme_id" STRING NOT NULL,
  "final_type" "AbstractFinalType" NOT NULL,
  "last_value" INT4 NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "abstract_code_counters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "abstract_code_counters_event_id_theme_id_final_type_key"
  ON "abstract_code_counters"("event_id", "theme_id", "final_type");

CREATE INDEX "abstract_code_counters_theme_id_idx"
  ON "abstract_code_counters"("theme_id");

ALTER TABLE "abstract_code_counters"
  ADD CONSTRAINT "abstract_code_counters_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "abstract_code_counters"
  ADD CONSTRAINT "abstract_code_counters_theme_id_fkey"
  FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

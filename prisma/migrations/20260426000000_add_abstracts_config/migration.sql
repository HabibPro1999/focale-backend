-- CreateEnum
CREATE TYPE "AbstractSubmissionMode" AS ENUM ('FREE_TEXT', 'STRUCTURED');

-- CreateEnum
CREATE TYPE "AbstractBookOrder" AS ENUM ('BY_CODE', 'BY_THEME', 'BY_SUBMISSION_ORDER');

-- CreateTable
CREATE TABLE "abstract_config" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "submission_mode" "AbstractSubmissionMode" NOT NULL DEFAULT 'FREE_TEXT',
    "global_word_limit" INT4 DEFAULT 500,
    "section_word_limits" JSONB,
    "submission_deadline" TIMESTAMP(3),
    "editing_deadline" TIMESTAMP(3),
    "scoring_deadline" TIMESTAMP(3),
    "final_file_deadline" TIMESTAMP(3),
    "editing_enabled" BOOL NOT NULL DEFAULT false,
    "comments_enabled" BOOL NOT NULL DEFAULT false,
    "comments_sent_to_author" BOOL NOT NULL DEFAULT false,
    "final_file_upload_enabled" BOOL NOT NULL DEFAULT false,
    "reviewers_per_abstract" INT4 NOT NULL DEFAULT 2,
    "divergence_threshold" INT4 NOT NULL DEFAULT 6,
    "distribute_by_theme" BOOL NOT NULL DEFAULT false,
    "mode_locked" BOOL NOT NULL DEFAULT false,
    "book_font_family" STRING NOT NULL DEFAULT 'Arial',
    "book_font_size" INT4 NOT NULL DEFAULT 11,
    "book_line_spacing" FLOAT8 NOT NULL DEFAULT 1.5,
    "book_order" "AbstractBookOrder" NOT NULL DEFAULT 'BY_CODE',
    "book_include_author_names" BOOL NOT NULL DEFAULT true,
    "additional_fields_schema" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_themes" (
    "id" STRING NOT NULL,
    "config_id" STRING NOT NULL,
    "label" STRING NOT NULL,
    "sort_order" INT4 NOT NULL DEFAULT 0,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abstract_config_event_id_key" ON "abstract_config"("event_id");

-- CreateIndex
CREATE INDEX "abstract_themes_config_id_active_idx" ON "abstract_themes"("config_id", "active");

-- AddForeignKey
ALTER TABLE "abstract_config" ADD CONSTRAINT "abstract_config_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_themes" ADD CONSTRAINT "abstract_themes_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "abstract_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

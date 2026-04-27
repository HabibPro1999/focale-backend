-- CreateEnum
CREATE TYPE "AbstractRequestedType" AS ENUM ('ORAL_COMMUNICATION', 'POSTER');

-- CreateEnum
CREATE TYPE "AbstractFinalType" AS ENUM ('ORAL_COMMUNICATION', 'POSTER');

-- CreateEnum
CREATE TYPE "AbstractStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'REVIEW_COMPLETE', 'ACCEPTED', 'REJECTED', 'PENDING');

-- CreateEnum
CREATE TYPE "AbstractFileKind" AS ENUM ('PDF', 'PPT', 'PPTX');

-- CreateEnum
CREATE TYPE "AbstractEmailTrigger" AS ENUM ('ABSTRACT_SUBMISSION_ACK', 'ABSTRACT_EDIT_ACK', 'ABSTRACT_DECISION', 'ABSTRACT_COMMITTEE_INVITE', 'ABSTRACT_COMMITTEE_COMMENTS', 'ABSTRACT_SCORE_DIVERGENCE', 'ABSTRACT_FINAL_FILE_REQUEST');

-- AlterTable: durable abstract email audit/debounce linkage
ALTER TABLE "email_logs" ADD COLUMN "abstract_id" STRING;
ALTER TABLE "email_logs" ADD COLUMN "abstract_trigger" "AbstractEmailTrigger";

-- AlterTable: add abstractTrigger to email_templates
ALTER TABLE "email_templates" ADD COLUMN "abstract_trigger" "AbstractEmailTrigger";

-- Replace the existing composite unique with two partial unique indexes.
-- The old index allows one template per (clientId, trigger, eventId) combo,
-- but now we need separate uniqueness for registration triggers and abstract triggers.
DROP INDEX IF EXISTS "email_templates_client_id_trigger_event_id_key";

CREATE UNIQUE INDEX "email_template_registration_uniq"
  ON "email_templates" ("client_id", "trigger", "event_id")
  WHERE "abstract_trigger" IS NULL;

CREATE UNIQUE INDEX "email_template_abstract_uniq"
  ON "email_templates" ("client_id", "abstract_trigger", "event_id")
  WHERE "trigger" IS NULL;

-- CreateTable
CREATE TABLE "abstracts" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "author_first_name" STRING NOT NULL,
    "author_last_name" STRING NOT NULL,
    "author_email" STRING NOT NULL,
    "author_phone" STRING NOT NULL,
    "requested_type" "AbstractRequestedType" NOT NULL,
    "content" JSONB NOT NULL,
    "co_authors" JSONB NOT NULL DEFAULT '[]',
    "additional_fields_data" JSONB NOT NULL DEFAULT '{}',
    "code" STRING,
    "code_number" INT4,
    "status" "AbstractStatus" NOT NULL DEFAULT 'SUBMITTED',
    "content_version" INT4 NOT NULL DEFAULT 1,
    "final_type" "AbstractFinalType",
    "average_score" FLOAT8,
    "review_count" INT4 NOT NULL DEFAULT 0,
    "final_file_key" STRING,
    "final_file_kind" "AbstractFileKind",
    "final_file_size" INT4,
    "final_file_uploaded_at" TIMESTAMP(3),
    "edit_token" STRING NOT NULL,
    "last_edited_at" TIMESTAMP(3),
    "link_base_url" STRING,
    "registration_id" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_revisions" (
    "id" STRING NOT NULL,
    "abstract_id" STRING NOT NULL,
    "revision_no" INT4 NOT NULL,
    "snapshot" JSONB NOT NULL,
    "edited_by" STRING NOT NULL,
    "edited_ip_address" STRING,
    "content" JSONB NOT NULL,
    "co_authors" JSONB NOT NULL DEFAULT '[]',
    "additional_fields_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abstract_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_theme_links" (
    "id" STRING NOT NULL,
    "abstract_id" STRING NOT NULL,
    "theme_id" STRING NOT NULL,

    CONSTRAINT "abstract_theme_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abstracts_edit_token_key" ON "abstracts"("edit_token");

-- CreateIndex
CREATE INDEX "abstracts_event_id_status_idx" ON "abstracts"("event_id", "status");

-- CreateIndex
CREATE INDEX "abstracts_event_id_created_at_idx" ON "abstracts"("event_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "abstracts_author_email_idx" ON "abstracts"("author_email");

-- CreateIndex
CREATE INDEX "abstracts_registration_id_idx" ON "abstracts"("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstracts_event_id_code_key" ON "abstracts"("event_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_revisions_abstract_id_revision_no_key" ON "abstract_revisions"("abstract_id", "revision_no");

-- CreateIndex
CREATE INDEX "email_logs_abstract_id_idx" ON "email_logs"("abstract_id");

-- CreateIndex
CREATE INDEX "email_logs_abstract_id_abstract_trigger_queued_at_idx" ON "email_logs"("abstract_id", "abstract_trigger", "queued_at");

-- CreateIndex
CREATE INDEX "abstract_theme_links_theme_id_idx" ON "abstract_theme_links"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_theme_links_abstract_id_theme_id_key" ON "abstract_theme_links"("abstract_id", "theme_id");

-- AddForeignKey
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "abstract_revisions" ADD CONSTRAINT "abstract_revisions_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

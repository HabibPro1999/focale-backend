-- Legacy production schema: what the Prisma app on main leaves in its
-- CockroachDB database. The adoption tests and the data-preservation tests
-- load it with createLegacyPrismaDatabase (tests/helpers/legacy-prisma.ts).
--
-- Section 1 is generated, unedited: Prisma 7.2.0 (main's bun.lock) from
-- prisma/schema.prisma at commit 0f86c91d (main), offline:
--
--   git show 0f86c91d:prisma/schema.prisma > prisma/schema.prisma
--   npx -y prisma@7.2.0 migrate diff --from-empty --to-schema prisma/schema.prisma --script
--
-- run beside this prisma.config.ts (Prisma 7 refuses to start without a
-- datasource; migrate diff --from-empty never connects to it):
--
--   export default {
--     schema: "prisma/schema.prisma",
--     datasource: { url: "postgresql://offline@127.0.0.1:1/offline" },
--   };
--
-- It is the schema `prisma db push` builds, so it includes the tables, types,
-- enum labels and columns production got from db push rather than from a
-- migration (certificate_templates, payment_transaction, RegistrationRole,
-- PaymentStatus PARTIAL, events.banner_url, ...).
--
-- Section 2 is what schema.prisma cannot declare but main's migrations
-- created, copied from prisma/migrations at 0f86c91d (the last version of
-- each object).
--
-- Section 3 is Prisma's migration table with main's 31 migration directories,
-- all finished, as `prisma migrate deploy` records them. checksum is the
-- sha256 of each migration.sql at 0f86c91d; ids and timestamps are made up.
--
-- The helper runs one statement at a time, each in its own transaction (on
-- CockroachDB a schema change cannot use a table changed earlier in the same
-- transaction). On PostgreSQL it reads STRING as TEXT and CREATE INVERTED
-- INDEX as a GIN index.

-- ============================================================================
-- Section 1: prisma migrate diff --from-empty --to-schema prisma/schema.prisma
-- ============================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('CLOSED', 'OPEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FormType" AS ENUM ('REGISTRATION', 'SPONSOR');

-- CreateEnum
CREATE TYPE "SponsorshipStatus" AS ENUM ('PENDING', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('WORKSHOP', 'DINNER', 'SESSION', 'NETWORKING', 'ACCOMMODATION', 'TRANSPORT', 'OTHER', 'ADDON');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'VERIFYING', 'PARTIAL', 'PAID', 'SPONSORED', 'WAIVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'ONLINE', 'CASH', 'LAB_SPONSORSHIP');

-- CreateEnum
CREATE TYPE "RegistrationRole" AS ENUM ('PARTICIPANT', 'SPEAKER', 'MODERATOR', 'ORGANIZER', 'INVITED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PAYMENT', 'REFUND', 'WAIVER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EmailTemplateCategory" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "AutomaticEmailTrigger" AS ENUM ('REGISTRATION_CREATED', 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_CONFIRMED', 'SPONSORSHIP_BATCH_SUBMITTED', 'SPONSORSHIP_LINKED', 'SPONSORSHIP_APPLIED', 'SPONSORSHIP_PARTIAL', 'CERTIFICATE_SENT');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AbstractSubmissionMode" AS ENUM ('FREE_TEXT', 'STRUCTURED');

-- CreateEnum
CREATE TYPE "AbstractBookOrder" AS ENUM ('BY_CODE', 'BY_THEME', 'BY_SUBMISSION_ORDER');

-- CreateEnum
CREATE TYPE "AbstractRequestedType" AS ENUM ('ORAL_COMMUNICATION', 'POSTER');

-- CreateEnum
CREATE TYPE "AbstractFinalType" AS ENUM ('CONFERENCE', 'ORAL_COMMUNICATION', 'POSTER');

-- CreateEnum
CREATE TYPE "AbstractStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'REVIEW_COMPLETE', 'ACCEPTED', 'REJECTED', 'PENDING');

-- CreateEnum
CREATE TYPE "AbstractFileKind" AS ENUM ('PDF', 'PPT', 'PPTX');

-- CreateEnum
CREATE TYPE "AbstractEmailTrigger" AS ENUM ('ABSTRACT_SUBMISSION_ACK', 'ABSTRACT_EDIT_ACK', 'ABSTRACT_DECISION', 'ABSTRACT_ACCEPTED', 'ABSTRACT_REJECTED', 'ABSTRACT_COMMITTEE_INVITE', 'ABSTRACT_COMMITTEE_COMMENTS', 'ABSTRACT_SCORE_DIVERGENCE', 'ABSTRACT_FINAL_FILE_REQUEST');

-- CreateEnum
CREATE TYPE "AbstractBookJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "clients" (
    "id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "logo" STRING,
    "primary_color" STRING,
    "email" STRING,
    "phone" STRING,
    "active" BOOL NOT NULL DEFAULT true,
    "enabled_modules" STRING[] DEFAULT ARRAY['pricing', 'registrations', 'sponsorships', 'emails', 'certificates', 'abstracts']::STRING[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" STRING NOT NULL,
    "email" STRING NOT NULL,
    "name" STRING NOT NULL,
    "role" INT4 NOT NULL DEFAULT 1,
    "client_id" STRING,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" STRING NOT NULL,
    "client_id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "slug" STRING NOT NULL,
    "description" STRING,
    "max_capacity" INT4,
    "registered_count" INT4 NOT NULL DEFAULT 0,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "location" STRING,
    "status" "EventStatus" NOT NULL DEFAULT 'CLOSED',
    "banner_url" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "type" "FormType" NOT NULL DEFAULT 'REGISTRATION',
    "name" STRING NOT NULL,
    "schema" JSONB NOT NULL,
    "schema_version" INT4 NOT NULL DEFAULT 1,
    "success_title" STRING,
    "success_message" STRING,
    "success_translations" JSONB,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_pricing" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "base_price" INT4 NOT NULL DEFAULT 0,
    "currency" STRING NOT NULL DEFAULT 'TND',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "online_payment_enabled" BOOL NOT NULL DEFAULT false,
    "online_payment_url" STRING,
    "cash_payment_enabled" BOOL NOT NULL DEFAULT false,
    "bank_name" STRING,
    "bank_account_name" STRING,
    "bank_account_number" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_access" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "type" "AccessType" NOT NULL DEFAULT 'OTHER',
    "name" STRING NOT NULL,
    "description" STRING,
    "location" STRING,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "price" INT4 NOT NULL DEFAULT 0,
    "currency" STRING NOT NULL DEFAULT 'TND',
    "max_capacity" INT4,
    "registered_count" INT4 NOT NULL DEFAULT 0,
    "paid_count" INT4 NOT NULL DEFAULT 0,
    "available_from" TIMESTAMP(3),
    "available_to" TIMESTAMP(3),
    "conditions" JSONB,
    "condition_logic" STRING NOT NULL DEFAULT 'AND',
    "sort_order" INT4 NOT NULL DEFAULT 0,
    "active" BOOL NOT NULL DEFAULT true,
    "group_label" STRING,
    "allow_companion" BOOL NOT NULL DEFAULT false,
    "included_in_base" BOOL NOT NULL DEFAULT false,
    "companion_price" INT4 NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_check_ins" (
    "id" STRING NOT NULL,
    "registration_id" STRING NOT NULL,
    "access_id" STRING NOT NULL,
    "checked_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_in_by" STRING NOT NULL,

    CONSTRAINT "access_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_templates" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "template_url" STRING NOT NULL,
    "template_width" INT4 NOT NULL,
    "template_height" INT4 NOT NULL,
    "zones" JSONB NOT NULL DEFAULT '[]',
    "applicable_roles" "RegistrationRole"[] DEFAULT ARRAY[]::"RegistrationRole"[],
    "access_id" STRING,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsorship_batches" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "form_id" STRING NOT NULL,
    "lab_name" STRING NOT NULL,
    "contact_name" STRING NOT NULL,
    "email" STRING NOT NULL,
    "phone" STRING,
    "form_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsorship_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsorships" (
    "id" STRING NOT NULL,
    "batch_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "code" STRING NOT NULL,
    "status" "SponsorshipStatus" NOT NULL DEFAULT 'PENDING',
    "beneficiary_name" STRING NOT NULL,
    "beneficiary_email" STRING NOT NULL,
    "beneficiary_phone" STRING,
    "beneficiary_address" STRING,
    "covers_base_price" BOOL NOT NULL DEFAULT true,
    "covered_access_ids" STRING[] DEFAULT ARRAY[]::STRING[],
    "total_amount" INT4 NOT NULL,
    "target_registration_id" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sponsorships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsorship_usages" (
    "id" STRING NOT NULL,
    "sponsorship_id" STRING NOT NULL,
    "registration_id" STRING,
    "amount_applied" INT4 NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" STRING NOT NULL,

    CONSTRAINT "sponsorship_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" STRING NOT NULL,
    "form_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "form_data" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "form_schema_version" INT4 NOT NULL DEFAULT 1,
    "email" STRING NOT NULL,
    "first_name" STRING,
    "last_name" STRING,
    "phone" STRING,
    "reference_number" STRING,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "total_amount" INT4 NOT NULL,
    "paid_amount" INT4 NOT NULL DEFAULT 0,
    "currency" STRING NOT NULL DEFAULT 'TND',
    "payment_method" "PaymentMethod",
    "payment_reference" STRING,
    "payment_proof_url" STRING,
    "price_breakdown" JSONB NOT NULL,
    "base_amount" INT4 NOT NULL DEFAULT 0,
    "discount_amount" INT4 NOT NULL DEFAULT 0,
    "access_amount" INT4 NOT NULL DEFAULT 0,
    "sponsorship_code" STRING,
    "sponsorship_amount" INT4 NOT NULL DEFAULT 0,
    "lab_name" STRING,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_edited_at" TIMESTAMP(3),
    "edit_token" STRING,
    "link_base_url" STRING,
    "idempotency_key" STRING,
    "note" STRING,
    "registration_role" "RegistrationRole" NOT NULL DEFAULT 'PARTICIPANT',
    "access_type_ids" STRING[] DEFAULT ARRAY[]::STRING[],
    "dropped_access_ids" STRING[] DEFAULT ARRAY[]::STRING[],
    "checked_in_at" TIMESTAMPTZ(6),
    "checked_in_by" STRING,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transaction" (
    "id" STRING NOT NULL,
    "registration_id" STRING NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" INT4 NOT NULL,
    "method" "PaymentMethod",
    "reference" STRING,
    "note" STRING,
    "performed_by" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" STRING NOT NULL,
    "client_id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "description" STRING,
    "subject" STRING NOT NULL,
    "content" JSONB NOT NULL,
    "mjml_content" STRING,
    "html_content" STRING,
    "plain_content" STRING,
    "category" "EmailTemplateCategory" NOT NULL,
    "trigger" "AutomaticEmailTrigger",
    "abstract_trigger" "AbstractEmailTrigger",
    "event_id" STRING,
    "is_default" BOOL NOT NULL DEFAULT false,
    "is_active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" STRING NOT NULL,
    "trigger" "AutomaticEmailTrigger",
    "template_id" STRING,
    "registration_id" STRING,
    "abstract_id" STRING,
    "recipient_email" STRING NOT NULL,
    "recipient_name" STRING,
    "abstract_trigger" "AbstractEmailTrigger",
    "subject" STRING NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "sendgrid_message_id" STRING,
    "error_message" STRING,
    "retry_count" INT4 NOT NULL DEFAULT 0,
    "max_retries" INT4 NOT NULL DEFAULT 3,
    "attempt_count" INT4 NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "locked_by" STRING,
    "context_snapshot" JSONB,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "bounced_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" STRING NOT NULL,
    "type" STRING NOT NULL,
    "aggregate_type" STRING,
    "aggregate_id" STRING,
    "client_id" STRING,
    "event_id" STRING,
    "dedupe_key" STRING,
    "payload" JSONB NOT NULL,
    "status" STRING NOT NULL DEFAULT 'PENDING',
    "attempt_count" INT4 NOT NULL DEFAULT 0,
    "max_attempts" INT4 NOT NULL DEFAULT 5,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "locked_by" STRING,
    "error_message" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" STRING NOT NULL,
    "entity_type" STRING NOT NULL,
    "entity_id" STRING NOT NULL,
    "action" STRING NOT NULL,
    "changes" JSONB,
    "performed_by" STRING,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" STRING,
    "user_agent" STRING,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_config" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "submission_mode" "AbstractSubmissionMode" NOT NULL DEFAULT 'FREE_TEXT',
    "global_word_limit" INT4 DEFAULT 500,
    "section_word_limits" JSONB,
    "submission_start_at" TIMESTAMP(3),
    "submission_deadline" TIMESTAMP(3),
    "editing_deadline" TIMESTAMP(3),
    "scoring_start_at" TIMESTAMP(3),
    "scoring_deadline" TIMESTAMP(3),
    "final_file_deadline" TIMESTAMP(3),
    "editing_enabled" BOOL NOT NULL DEFAULT false,
    "comments_enabled" BOOL NOT NULL DEFAULT false,
    "comments_sent_to_author" BOOL NOT NULL DEFAULT false,
    "final_file_upload_enabled" BOOL NOT NULL DEFAULT false,
    "reviewers_per_abstract" INT4 NOT NULL DEFAULT 2,
    "divergence_threshold" INT4 NOT NULL DEFAULT 6,
    "max_themes_per_abstract" INT4,
    "distribute_by_theme" BOOL NOT NULL DEFAULT false,
    "mode_locked" BOOL NOT NULL DEFAULT false,
    "book_font_family" STRING NOT NULL DEFAULT 'Arial',
    "book_font_size" INT4 NOT NULL DEFAULT 11,
    "book_line_spacing" FLOAT8 NOT NULL DEFAULT 1.5,
    "book_order" "AbstractBookOrder" NOT NULL DEFAULT 'BY_CODE',
    "book_include_author_names" BOOL NOT NULL DEFAULT true,
    "additional_fields_schema" JSONB NOT NULL DEFAULT '[]',
    "languages" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_themes" (
    "id" STRING NOT NULL,
    "config_id" STRING NOT NULL,
    "label" STRING NOT NULL,
    "description" STRING,
    "translations" JSONB,
    "sort_order" INT4 NOT NULL DEFAULT 0,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "abstract_code_sequences" (
    "id" STRING NOT NULL,
    "final_type" "AbstractFinalType" NOT NULL,
    "last_value" INT4 NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_code_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_book_jobs" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "requested_by" STRING NOT NULL,
    "status" "AbstractBookJobStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" STRING,
    "error_message" STRING,
    "included_count" INT4 NOT NULL DEFAULT 0,
    "attempt_count" INT4 NOT NULL DEFAULT 0,
    "max_attempts" INT4 NOT NULL DEFAULT 3,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "locked_by" STRING,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_book_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstracts" (
    "id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "author_first_name" STRING NOT NULL,
    "author_last_name" STRING NOT NULL,
    "author_affiliation" STRING,
    "author_email" STRING NOT NULL,
    "author_email_normalized" STRING,
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
    "presented_at" TIMESTAMP(3),
    "presented_by" STRING,
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
CREATE TABLE "abstract_committee_memberships" (
    "id" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_committee_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_invite_tokens" (
    "id" STRING NOT NULL,
    "token_hash" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" STRING,

    CONSTRAINT "committee_invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_reviews" (
    "id" STRING NOT NULL,
    "abstract_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "reviewer_id" STRING NOT NULL,
    "score" FLOAT8,
    "comment" STRING,
    "scored_at" TIMESTAMP(3),
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_reviewer_themes" (
    "id" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "theme_id" STRING NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_reviewer_themes_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "_AccessPrerequisites" (
    "A" STRING NOT NULL,
    "B" STRING NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_client_id_idx" ON "users"("client_id");

-- CreateIndex
CREATE INDEX "users_active_role_idx" ON "users"("active", "role");

-- CreateIndex
CREATE INDEX "users_client_id_role_idx" ON "users"("client_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "events_slug_key" ON "events"("slug");

-- CreateIndex
CREATE INDEX "events_client_id_status_idx" ON "events"("client_id", "status");

-- CreateIndex
CREATE INDEX "forms_event_id_idx" ON "forms"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "forms_event_id_type_key" ON "forms"("event_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "event_pricing_event_id_key" ON "event_pricing"("event_id");

-- CreateIndex
CREATE INDEX "event_access_event_id_starts_at_idx" ON "event_access"("event_id", "starts_at");

-- CreateIndex
CREATE INDEX "event_access_event_id_type_idx" ON "event_access"("event_id", "type");

-- CreateIndex
CREATE INDEX "event_access_event_id_active_idx" ON "event_access"("event_id", "active");

-- CreateIndex
CREATE INDEX "event_access_event_id_type_active_idx" ON "event_access"("event_id", "type", "active");

-- CreateIndex
CREATE INDEX "access_check_ins_access_id_idx" ON "access_check_ins"("access_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_check_ins_registration_id_access_id_key" ON "access_check_ins"("registration_id", "access_id");

-- CreateIndex
CREATE INDEX "certificate_templates_event_id_idx" ON "certificate_templates"("event_id");

-- CreateIndex
CREATE INDEX "sponsorship_batches_event_id_idx" ON "sponsorship_batches"("event_id");

-- CreateIndex
CREATE INDEX "sponsorship_batches_email_idx" ON "sponsorship_batches"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sponsorships_code_key" ON "sponsorships"("code");

-- CreateIndex
CREATE INDEX "sponsorships_event_id_idx" ON "sponsorships"("event_id");

-- CreateIndex
CREATE INDEX "sponsorships_batch_id_idx" ON "sponsorships"("batch_id");

-- CreateIndex
CREATE INDEX "sponsorships_event_id_status_idx" ON "sponsorships"("event_id", "status");

-- CreateIndex
CREATE INDEX "sponsorships_status_idx" ON "sponsorships"("status");

-- CreateIndex
CREATE INDEX "sponsorships_batch_id_status_idx" ON "sponsorships"("batch_id", "status");

-- CreateIndex
CREATE INDEX "sponsorship_usages_registration_id_idx" ON "sponsorship_usages"("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "sponsorship_usages_sponsorship_id_registration_id_key" ON "sponsorship_usages"("sponsorship_id", "registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_reference_number_key" ON "registrations"("reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_edit_token_key" ON "registrations"("edit_token");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_idempotency_key_key" ON "registrations"("idempotency_key");

-- CreateIndex
CREATE INDEX "registrations_event_id_payment_status_idx" ON "registrations"("event_id", "payment_status");

-- CreateIndex
CREATE INDEX "registrations_event_id_submitted_at_idx" ON "registrations"("event_id", "submitted_at");

-- CreateIndex
CREATE INDEX "registrations_form_id_idx" ON "registrations"("form_id");

-- CreateIndex
CREATE INDEX "registrations_email_idx" ON "registrations"("email");

-- CreateIndex
CREATE INDEX "registrations_sponsorship_code_idx" ON "registrations"("sponsorship_code");

-- CreateIndex
CREATE INDEX "registrations_payment_status_updated_at_idx" ON "registrations"("payment_status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_email_form_id_key" ON "registrations"("email", "form_id");

-- CreateIndex
CREATE INDEX "payment_transaction_registration_id_idx" ON "payment_transaction"("registration_id");

-- CreateIndex
CREATE INDEX "email_templates_client_id_category_idx" ON "email_templates"("client_id", "category");

-- CreateIndex
CREATE INDEX "email_templates_client_id_trigger_idx" ON "email_templates"("client_id", "trigger");

-- CreateIndex
CREATE INDEX "email_templates_event_id_idx" ON "email_templates"("event_id");

-- CreateIndex
CREATE INDEX "email_logs_registration_id_idx" ON "email_logs"("registration_id");

-- CreateIndex
CREATE INDEX "email_logs_abstract_id_idx" ON "email_logs"("abstract_id");

-- CreateIndex
CREATE INDEX "email_logs_abstract_id_abstract_trigger_queued_at_idx" ON "email_logs"("abstract_id", "abstract_trigger", "queued_at");

-- CreateIndex
CREATE INDEX "email_logs_status_queued_at_idx" ON "email_logs"("status", "queued_at");

-- CreateIndex
CREATE INDEX "email_logs_status_retry_count_idx" ON "email_logs"("status", "retry_count");

-- CreateIndex
CREATE INDEX "email_logs_status_next_attempt_at_queued_at_idx" ON "email_logs"("status", "next_attempt_at", "queued_at");

-- CreateIndex
CREATE INDEX "email_logs_status_locked_until_idx" ON "email_logs"("status", "locked_until");

-- CreateIndex
CREATE INDEX "email_logs_locked_by_idx" ON "email_logs"("locked_by");

-- CreateIndex
CREATE INDEX "email_logs_recipient_email_idx" ON "email_logs"("recipient_email");

-- CreateIndex
CREATE INDEX "email_logs_sendgrid_message_id_idx" ON "email_logs"("sendgrid_message_id");

-- CreateIndex
CREATE INDEX "email_logs_trigger_queued_at_idx" ON "email_logs"("trigger", "queued_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_locked_until_idx" ON "outbox_events"("status", "locked_until");

-- CreateIndex
CREATE INDEX "outbox_events_locked_by_idx" ON "outbox_events"("locked_by");

-- CreateIndex
CREATE INDEX "outbox_events_type_idx" ON "outbox_events"("type");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "outbox_events_client_id_event_id_idx" ON "outbox_events"("client_id", "event_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs"("performed_by");

-- CreateIndex
CREATE INDEX "audit_logs_performed_at_idx" ON "audit_logs"("performed_at");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_config_event_id_key" ON "abstract_config"("event_id");

-- CreateIndex
CREATE INDEX "abstract_themes_config_id_active_idx" ON "abstract_themes"("config_id", "active");

-- CreateIndex
CREATE INDEX "abstract_code_counters_theme_id_idx" ON "abstract_code_counters"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_code_counters_event_id_theme_id_final_type_key" ON "abstract_code_counters"("event_id", "theme_id", "final_type");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_code_sequences_final_type_key" ON "abstract_code_sequences"("final_type");

-- CreateIndex
CREATE INDEX "abstract_book_jobs_event_id_created_at_idx" ON "abstract_book_jobs"("event_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "abstract_book_jobs_status_created_at_idx" ON "abstract_book_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "abstract_book_jobs_status_next_attempt_at_created_at_idx" ON "abstract_book_jobs"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "abstract_book_jobs_status_locked_until_idx" ON "abstract_book_jobs"("status", "locked_until");

-- CreateIndex
CREATE INDEX "abstract_book_jobs_locked_by_idx" ON "abstract_book_jobs"("locked_by");

-- CreateIndex
CREATE UNIQUE INDEX "abstracts_edit_token_key" ON "abstracts"("edit_token");

-- CreateIndex
CREATE INDEX "abstracts_event_id_status_idx" ON "abstracts"("event_id", "status");

-- CreateIndex
CREATE INDEX "abstracts_event_id_created_at_idx" ON "abstracts"("event_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "abstracts_author_email_idx" ON "abstracts"("author_email");

-- CreateIndex
CREATE INDEX "abstracts_event_id_author_email_normalized_idx" ON "abstracts"("event_id", "author_email_normalized");

-- CreateIndex
CREATE INDEX "abstracts_registration_id_idx" ON "abstracts"("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstracts_event_id_code_key" ON "abstracts"("event_id", "code");

-- CreateIndex
CREATE INDEX "abstract_committee_memberships_event_id_active_idx" ON "abstract_committee_memberships"("event_id", "active");

-- CreateIndex
CREATE INDEX "abstract_committee_memberships_user_id_active_idx" ON "abstract_committee_memberships"("user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_committee_memberships_user_id_event_id_key" ON "abstract_committee_memberships"("user_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "committee_invite_tokens_token_hash_key" ON "committee_invite_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "committee_invite_tokens_user_id_event_id_idx" ON "committee_invite_tokens"("user_id", "event_id");

-- CreateIndex
CREATE INDEX "abstract_reviews_reviewer_id_event_id_active_scored_at_idx" ON "abstract_reviews"("reviewer_id", "event_id", "active", "scored_at");

-- CreateIndex
CREATE INDEX "abstract_reviews_event_id_active_scored_at_idx" ON "abstract_reviews"("event_id", "active", "scored_at");

-- CreateIndex
CREATE INDEX "abstract_reviews_abstract_id_active_idx" ON "abstract_reviews"("abstract_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_reviews_abstract_id_reviewer_id_key" ON "abstract_reviews"("abstract_id", "reviewer_id");

-- CreateIndex
CREATE INDEX "abstract_reviewer_themes_event_id_theme_id_idx" ON "abstract_reviewer_themes"("event_id", "theme_id");

-- CreateIndex
CREATE INDEX "abstract_reviewer_themes_user_id_event_id_active_idx" ON "abstract_reviewer_themes"("user_id", "event_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_reviewer_themes_user_id_event_id_theme_id_key" ON "abstract_reviewer_themes"("user_id", "event_id", "theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_revisions_abstract_id_revision_no_key" ON "abstract_revisions"("abstract_id", "revision_no");

-- CreateIndex
CREATE INDEX "abstract_theme_links_theme_id_idx" ON "abstract_theme_links"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_theme_links_abstract_id_theme_id_key" ON "abstract_theme_links"("abstract_id", "theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "_AccessPrerequisites_AB_unique" ON "_AccessPrerequisites"("A", "B");

-- CreateIndex
CREATE INDEX "_AccessPrerequisites_B_index" ON "_AccessPrerequisites"("B");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_pricing" ADD CONSTRAINT "event_pricing_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_access" ADD CONSTRAINT "event_access_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "event_access"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorship_batches" ADD CONSTRAINT "sponsorship_batches_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorship_batches" ADD CONSTRAINT "sponsorship_batches_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "sponsorship_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorship_usages" ADD CONSTRAINT "sponsorship_usages_sponsorship_id_fkey" FOREIGN KEY ("sponsorship_id") REFERENCES "sponsorships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsorship_usages" ADD CONSTRAINT "sponsorship_usages_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_config" ADD CONSTRAINT "abstract_config_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_themes" ADD CONSTRAINT "abstract_themes_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "abstract_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_code_counters" ADD CONSTRAINT "abstract_code_counters_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_code_counters" ADD CONSTRAINT "abstract_code_counters_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_book_jobs" ADD CONSTRAINT "abstract_book_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_invite_tokens" ADD CONSTRAINT "committee_invite_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_invite_tokens" ADD CONSTRAINT "committee_invite_tokens_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_revisions" ADD CONSTRAINT "abstract_revisions_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_A_fkey" FOREIGN KEY ("A") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_B_fkey" FOREIGN KEY ("B") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Section 2: main's migrations, objects schema.prisma cannot declare
-- ============================================================================

-- 20260319000001_add_inverted_index_access_type_ids
CREATE INVERTED INDEX "registrations_access_type_ids_inverted_idx"
  ON "registrations" ("access_type_ids");

-- 20260426100000_add_abstracts_submission
CREATE UNIQUE INDEX "email_template_registration_uniq"
  ON "email_templates" ("client_id", "trigger", "event_id")
  WHERE "abstract_trigger" IS NULL;

CREATE UNIQUE INDEX "email_template_abstract_uniq"
  ON "email_templates" ("client_id", "abstract_trigger", "event_id")
  WHERE "trigger" IS NULL;

-- 20260516000000_add_dedupe_hardening (its email_logs_registration_trigger_active_key
-- was replaced by 20260528000000, below)
CREATE UNIQUE INDEX IF NOT EXISTS "abstracts_event_id_author_email_normalized_key"
  ON "abstracts" ("event_id", "author_email_normalized")
  WHERE "author_email_normalized" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_abstract_submission_ack_active_key"
  ON "email_logs" ("abstract_id", "abstract_trigger", "recipient_email")
  WHERE "abstract_id" IS NOT NULL
    AND "abstract_trigger" = 'ABSTRACT_SUBMISSION_ACK'
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED');

-- 20260516001000_add_outbox_events
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_dedupe_key_key"
  ON "outbox_events" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;

-- 20260528000000_extend_email_trigger_dedupe
CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_registration_trigger_active_key"
  ON "email_logs" ("registration_id", "trigger")
  WHERE "registration_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';

CREATE UNIQUE INDEX IF NOT EXISTS "email_logs_template_recipient_trigger_active_key"
  ON "email_logs" ("template_id", "recipient_email", "trigger")
  WHERE "template_id" IS NOT NULL
    AND "trigger" IS NOT NULL
    AND "status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
    AND "queued_at" >= TIMESTAMP '2026-05-29 00:03:03';

-- 0_init created this column; schema.prisma no longer declares it and no
-- migration drops it.
ALTER TABLE "registrations" ADD COLUMN "edit_token_expiry" TIMESTAMP(3);

-- 20260319000003_fix_prod_event_access_columns notes that production's
-- companion_price is bigint, not schema.prisma's INT4.
ALTER TABLE "event_access" ALTER COLUMN "companion_price" SET DATA TYPE INT8;

-- 20260525000000_align_prod_dev_schema
ALTER TABLE "access_check_ins"
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;

-- 20260525001000_normalize_checkin_timestamp_default
ALTER TABLE "access_check_ins"
  ALTER COLUMN "checked_in_at" SET DEFAULT now();

-- ============================================================================
-- Section 3: Prisma's migration table, every migration of main finished
-- ============================================================================

CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
VALUES
  ('00000000-0000-4000-8000-000000000001', '503f3bd0bd3e2d4587af93942800961f62551b23ae0552470942a2bcdf020dfa', '2026-02-01 12:00:00+00', '0_init', NULL, NULL, '2026-02-01 12:00:00+00', 1),
  ('00000000-0000-4000-8000-000000000002', '5b841c9f5e5f3440f40ef6796a14485ba09bf6a66fff56d9aa62907b67569f45', '2026-02-23 12:00:01+00', '20260223000000_add_target_registration_id', NULL, NULL, '2026-02-23 12:00:01+00', 1),
  ('00000000-0000-4000-8000-000000000003', 'cf9a00734f1904c77a640499da42fcbccfaf024029bffd973cff7b6cb13a20b6', '2026-03-19 12:00:02+00', '20260319000000_align_develop_db_to_schema', NULL, NULL, '2026-03-19 12:00:02+00', 1),
  ('00000000-0000-4000-8000-000000000004', '28e5127770c93c1ed8e90c6f76c415d406ab896b8be8dec1ec3dfde90514b373', '2026-03-19 12:00:03+00', '20260319000001_add_inverted_index_access_type_ids', NULL, NULL, '2026-03-19 12:00:03+00', 1),
  ('00000000-0000-4000-8000-000000000005', 'ed7a43e0fa39588e5957211952840ace6aa9e16efb70ecc06392ca67f598fb85', '2026-03-19 12:00:04+00', '20260319000002_add_sponsorship_event_status_index', NULL, NULL, '2026-03-19 12:00:04+00', 1),
  ('00000000-0000-4000-8000-000000000006', '645ac59db4c07d96dfee79b82f445160fbace0cdb18cba6511ed399a00755c4a', '2026-03-19 12:00:05+00', '20260319000003_fix_prod_event_access_columns', NULL, NULL, '2026-03-19 12:00:05+00', 1),
  ('00000000-0000-4000-8000-000000000007', 'e5d0b0300e03a61da3f5b0c780a5ff24e94cf2d6d1337f7b11f15bb6b095f9fb', '2026-03-19 12:00:06+00', '20260319000004_drop_unused_indexes', NULL, NULL, '2026-03-19 12:00:06+00', 1),
  ('00000000-0000-4000-8000-000000000008', '2f36bc1062604c523097b98d0ee650f52da83a2b87f8e5778fc098b764bed41e', '2026-03-23 12:00:07+00', '20260323000000_add_certificates_module', NULL, NULL, '2026-03-23 12:00:07+00', 1),
  ('00000000-0000-4000-8000-000000000009', '8d2797f9aa5c50ca90da78685853cdb3e6d2852497ba56cc37136baf5ba21d80', '2026-03-25 12:00:08+00', '20260325000000_add_reference_number', NULL, NULL, '2026-03-25 12:00:08+00', 1),
  ('00000000-0000-4000-8000-000000000010', '92541ab1f65b7d9f7aed72236133d99a61a72b87182903a12013894435de5407', '2026-04-03 12:00:09+00', '20260403000000_add_checkin_module', NULL, NULL, '2026-04-03 12:00:09+00', 1),
  ('00000000-0000-4000-8000-000000000011', '41f09a4cc677c47284c6b562fe7bdc79c306efdd5e1eace4caac2dd16fcc5c10', '2026-04-11 12:00:10+00', '20260411000000_add_certificate_sent_trigger', NULL, NULL, '2026-04-11 12:00:10+00', 1),
  ('00000000-0000-4000-8000-000000000012', 'c8ff025b597091fb1b2a74b7ee1551291f235e14769429e518e870c45e6e7d31', '2026-04-26 12:00:11+00', '20260426000000_add_abstracts_config', NULL, NULL, '2026-04-26 12:00:11+00', 1),
  ('00000000-0000-4000-8000-000000000013', '81cdc6728197587c77c0645b1398059b48abb0ed3eb5ccab6e66e7eeb0134d35', '2026-04-26 12:00:12+00', '20260426100000_add_abstracts_submission', NULL, NULL, '2026-04-26 12:00:12+00', 1),
  ('00000000-0000-4000-8000-000000000014', '62e88f52ea1b699bccbf5cadcc0f5e05a4d386d656e15b09a37575d467f397fb', '2026-04-26 12:00:13+00', '20260426210000_add_committee_scoring_foundation', NULL, NULL, '2026-04-26 12:00:13+00', 1),
  ('00000000-0000-4000-8000-000000000015', '753c82e5eccc54e0ba927e6ad0cfb0b33c29ab390c72c42dd37078b2fed53c69', '2026-04-26 12:00:14+00', '20260426300000_add_abstract_finalization', NULL, NULL, '2026-04-26 12:00:14+00', 1),
  ('00000000-0000-4000-8000-000000000016', '5201b1fe5777965cba70bfb1c126fe21e0cf37c425787f53ff8ccf2be74bd7af', '2026-04-26 12:00:15+00', '20260426400000_add_abstract_book_jobs', NULL, NULL, '2026-04-26 12:00:15+00', 1),
  ('00000000-0000-4000-8000-000000000017', '4eb0d0e75fb1b6661f82bf316b8ef0c8bcc2faa5163dc31aed0c6c16409cef57', '2026-05-01 12:00:16+00', '20260501000000_add_worker_job_leases', NULL, NULL, '2026-05-01 12:00:16+00', 1),
  ('00000000-0000-4000-8000-000000000018', '61ae5f15b7f0cb62f742bb9b3144af2b8f95905c29cf3d3c8148af22c28a3a53', '2026-05-12 12:00:17+00', '20260512000000_add_abstract_code_number_unique', NULL, NULL, '2026-05-12 12:00:17+00', 1),
  ('00000000-0000-4000-8000-000000000019', '61b444e8f3439914047984a7fa34e15c72e96a83d33b08845a594b32fc5fdf0b', '2026-05-14 12:00:18+00', '20260514000000_tshg_abstract_requirements', NULL, NULL, '2026-05-14 12:00:18+00', 1),
  ('00000000-0000-4000-8000-000000000020', '287dd6c3adb783fc4a58cb720d3f5165bd2f5ae3be830ce454c8017919f02d97', '2026-05-16 12:00:19+00', '20260516000000_add_dedupe_hardening', NULL, NULL, '2026-05-16 12:00:19+00', 1),
  ('00000000-0000-4000-8000-000000000021', 'dbc8fae1d4a44c9382af63f267e3801acf7acd0cbc977a3163866985c5fb1f03', '2026-05-16 12:00:20+00', '20260516001000_add_outbox_events', NULL, NULL, '2026-05-16 12:00:20+00', 1),
  ('00000000-0000-4000-8000-000000000022', '746a73dd38925efbcbdb47e3ad406ca4abae8d3c1f59f27101d16cddd4811620', '2026-05-22 12:00:21+00', '20260522000000_add_abstracts_module_default', NULL, NULL, '2026-05-22 12:00:21+00', 1),
  ('00000000-0000-4000-8000-000000000023', 'f86a879ec5b865ec56f3c78f0271b4ddbcbb9230b918a1528b008b19930a6881', '2026-05-24 12:00:22+00', '20260524000000_add_abstract_decision_email_triggers', NULL, NULL, '2026-05-24 12:00:22+00', 1),
  ('00000000-0000-4000-8000-000000000024', '564d9db903b105f60f73a1c3427d60254be05f5a8a3e985cf5dba966a02f61b4', '2026-05-24 12:00:23+00', '20260524001000_add_abstract_code_sequences', NULL, NULL, '2026-05-24 12:00:23+00', 1),
  ('00000000-0000-4000-8000-000000000025', '0878ca1eb754bc8028420582fa3b2d0850b810c78dd3cae22b0f70835f5e64cd', '2026-05-24 12:00:24+00', '20260524002000_add_abstract_theme_descriptions', NULL, NULL, '2026-05-24 12:00:24+00', 1),
  ('00000000-0000-4000-8000-000000000026', 'cfc5f146ad4a2b45a088968123250ec5ccc1dac1ec02ea30764abb482046e60d', '2026-05-25 12:00:25+00', '20260525000000_align_prod_dev_schema', NULL, NULL, '2026-05-25 12:00:25+00', 1),
  ('00000000-0000-4000-8000-000000000027', '0333df53cdc365caf8d9fe9da8bd4714554c96495284a9faad3aff584c143bf9', '2026-05-25 12:00:26+00', '20260525001000_normalize_checkin_timestamp_default', NULL, NULL, '2026-05-25 12:00:26+00', 1),
  ('00000000-0000-4000-8000-000000000028', '9c037cb1f63a5130f334715a021685bcd3c85aac1afc446f8edd11cfe673519f', '2026-05-28 12:00:27+00', '20260528000000_extend_email_trigger_dedupe', NULL, NULL, '2026-05-28 12:00:27+00', 1),
  ('00000000-0000-4000-8000-000000000029', '0319e8aa72caa98d62e72a2527a52575c005f28c787a680eb4a2d16517c9c480', '2026-05-30 12:00:28+00', '20260530000000_add_abstract_author_affiliation', NULL, NULL, '2026-05-30 12:00:28+00', 1),
  ('00000000-0000-4000-8000-000000000030', '141aa4b7b65ba5b52b34d49515c1baa8f896a2471c4f171f6de03f6d2784f5a3', '2026-08-06 12:00:29+00', '20260806000000_add_multilanguage_forms', NULL, NULL, '2026-08-06 12:00:29+00', 1),
  ('00000000-0000-4000-8000-000000000031', '1203f05f5e20135337e29e509b7dd9d4d66e595f285e0c0c3cb3e933025b3072', '2026-08-14 12:00:30+00', '20260814000000_add_committee_invite_tokens', NULL, NULL, '2026-08-14 12:00:30+00', 1);

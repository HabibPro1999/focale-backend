-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('CLOSED', 'OPEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FormType" AS ENUM ('REGISTRATION', 'SPONSOR');

-- CreateEnum
CREATE TYPE "SponsorshipStatus" AS ENUM ('PENDING', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('WORKSHOP', 'DINNER', 'SESSION', 'NETWORKING', 'ACCOMMODATION', 'TRANSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'VERIFYING', 'PAID', 'REFUNDED', 'WAIVED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'ONLINE', 'CASH');

-- CreateEnum
CREATE TYPE "EmailTemplateCategory" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "AutomaticEmailTrigger" AS ENUM ('REGISTRATION_CREATED', 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_CONFIRMED', 'SPONSORSHIP_BATCH_SUBMITTED', 'SPONSORSHIP_LINKED', 'SPONSORSHIP_APPLIED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "clients" (
    "id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "logo" STRING,
    "primary_color" STRING,
    "email" STRING,
    "phone" STRING,
    "active" BOOL NOT NULL DEFAULT true,
    "enabled_modules" STRING[] DEFAULT ARRAY['pricing', 'registrations', 'sponsorships', 'emails']::STRING[],
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
    "available_from" TIMESTAMP(3),
    "available_to" TIMESTAMP(3),
    "conditions" JSONB,
    "condition_logic" STRING NOT NULL DEFAULT 'AND',
    "sort_order" INT4 NOT NULL DEFAULT 0,
    "active" BOOL NOT NULL DEFAULT true,
    "group_label" STRING,
    "allow_companion" BOOL NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_access_pkey" PRIMARY KEY ("id")
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
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_edited_at" TIMESTAMP(3),
    "edit_token" STRING,
    "edit_token_expiry" TIMESTAMP(3),
    "link_base_url" STRING,
    "idempotency_key" STRING,
    "note" STRING,
    "access_type_ids" STRING[] DEFAULT ARRAY[]::STRING[],

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
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
    "recipient_email" STRING NOT NULL,
    "recipient_name" STRING,
    "subject" STRING NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "sendgrid_message_id" STRING,
    "error_message" STRING,
    "retry_count" INT4 NOT NULL DEFAULT 0,
    "max_retries" INT4 NOT NULL DEFAULT 3,
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
CREATE INDEX "sponsorships_code_idx" ON "sponsorships"("code");

-- CreateIndex
CREATE INDEX "sponsorships_status_idx" ON "sponsorships"("status");

-- CreateIndex
CREATE INDEX "sponsorships_beneficiary_email_idx" ON "sponsorships"("beneficiary_email");

-- CreateIndex
CREATE INDEX "sponsorship_usages_registration_id_idx" ON "sponsorship_usages"("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "sponsorship_usages_sponsorship_id_registration_id_key" ON "sponsorship_usages"("sponsorship_id", "registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_edit_token_key" ON "registrations"("edit_token");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_idempotency_key_key" ON "registrations"("idempotency_key");

-- CreateIndex
CREATE INDEX "registrations_event_id_payment_status_idx" ON "registrations"("event_id", "payment_status");

-- CreateIndex
CREATE INDEX "registrations_event_id_submitted_at_idx" ON "registrations"("event_id", "submitted_at");

-- CreateIndex
CREATE INDEX "registrations_event_id_paid_at_idx" ON "registrations"("event_id", "paid_at");

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
CREATE INDEX "email_templates_client_id_category_idx" ON "email_templates"("client_id", "category");

-- CreateIndex
CREATE INDEX "email_templates_client_id_trigger_idx" ON "email_templates"("client_id", "trigger");

-- CreateIndex
CREATE INDEX "email_templates_event_id_idx" ON "email_templates"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_client_id_trigger_event_id_key" ON "email_templates"("client_id", "trigger", "event_id");

-- CreateIndex
CREATE INDEX "email_logs_registration_id_idx" ON "email_logs"("registration_id");

-- CreateIndex
CREATE INDEX "email_logs_status_queued_at_idx" ON "email_logs"("status", "queued_at");

-- CreateIndex
CREATE INDEX "email_logs_status_retry_count_idx" ON "email_logs"("status", "retry_count");

-- CreateIndex
CREATE INDEX "email_logs_recipient_email_idx" ON "email_logs"("recipient_email");

-- CreateIndex
CREATE INDEX "email_logs_sendgrid_message_id_idx" ON "email_logs"("sendgrid_message_id");

-- CreateIndex
CREATE INDEX "email_logs_trigger_queued_at_idx" ON "email_logs"("trigger", "queued_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs"("performed_by");

-- CreateIndex
CREATE INDEX "audit_logs_performed_at_idx" ON "audit_logs"("performed_at");

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
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_A_fkey" FOREIGN KEY ("A") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_B_fkey" FOREIGN KEY ("B") REFERENCES "event_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;


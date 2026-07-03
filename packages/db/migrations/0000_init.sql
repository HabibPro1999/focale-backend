CREATE TYPE "public"."AbstractBookJobStatus" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."AbstractBookOrder" AS ENUM('BY_CODE', 'BY_THEME', 'BY_SUBMISSION_ORDER');--> statement-breakpoint
CREATE TYPE "public"."AbstractEmailTrigger" AS ENUM('ABSTRACT_SUBMISSION_ACK', 'ABSTRACT_EDIT_ACK', 'ABSTRACT_DECISION', 'ABSTRACT_ACCEPTED', 'ABSTRACT_REJECTED', 'ABSTRACT_COMMITTEE_INVITE', 'ABSTRACT_COMMITTEE_COMMENTS', 'ABSTRACT_SCORE_DIVERGENCE', 'ABSTRACT_FINAL_FILE_REQUEST');--> statement-breakpoint
CREATE TYPE "public"."AbstractFileKind" AS ENUM('PDF', 'PPT', 'PPTX');--> statement-breakpoint
CREATE TYPE "public"."AbstractFinalType" AS ENUM('CONFERENCE', 'ORAL_COMMUNICATION', 'POSTER');--> statement-breakpoint
CREATE TYPE "public"."AbstractRequestedType" AS ENUM('ORAL_COMMUNICATION', 'POSTER');--> statement-breakpoint
CREATE TYPE "public"."AbstractStatus" AS ENUM('SUBMITTED', 'UNDER_REVIEW', 'REVIEW_COMPLETE', 'ACCEPTED', 'REJECTED', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."AbstractSubmissionMode" AS ENUM('FREE_TEXT', 'STRUCTURED');--> statement-breakpoint
CREATE TYPE "public"."AccessType" AS ENUM('WORKSHOP', 'DINNER', 'SESSION', 'NETWORKING', 'ACCOMMODATION', 'TRANSPORT', 'OTHER', 'ADDON');--> statement-breakpoint
CREATE TYPE "public"."AutomaticEmailTrigger" AS ENUM('REGISTRATION_CREATED', 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_CONFIRMED', 'SPONSORSHIP_BATCH_SUBMITTED', 'SPONSORSHIP_LINKED', 'SPONSORSHIP_APPLIED', 'SPONSORSHIP_PARTIAL', 'CERTIFICATE_SENT');--> statement-breakpoint
CREATE TYPE "public"."EmailStatus" AS ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'DROPPED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."EmailTemplateCategory" AS ENUM('AUTOMATIC', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."EventStatus" AS ENUM('CLOSED', 'OPEN', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."FormType" AS ENUM('REGISTRATION', 'SPONSOR');--> statement-breakpoint
CREATE TYPE "public"."PaymentMethod" AS ENUM('BANK_TRANSFER', 'ONLINE', 'CASH', 'LAB_SPONSORSHIP');--> statement-breakpoint
CREATE TYPE "public"."PaymentStatus" AS ENUM('PENDING', 'VERIFYING', 'PARTIAL', 'PAID', 'SPONSORED', 'WAIVED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."RegistrationRole" AS ENUM('PARTICIPANT', 'SPEAKER', 'MODERATOR', 'ORGANIZER', 'INVITED');--> statement-breakpoint
CREATE TYPE "public"."SponsorshipStatus" AS ENUM('PENDING', 'USED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."TransactionType" AS ENUM('PAYMENT', 'REFUND', 'WAIVER', 'ADJUSTMENT');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo" text,
	"primary_color" text,
	"email" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"enabled_modules" text[] DEFAULT '{"pricing","registrations","sponsorships","emails","certificates","abstracts"}',
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" integer DEFAULT 1 NOT NULL,
	"client_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_check_ins" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"access_id" text NOT NULL,
	"checked_in_at" timestamp (3) DEFAULT now() NOT NULL,
	"checked_in_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_AccessPrerequisites" (
	"A" text NOT NULL,
	"B" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_access" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" "AccessType" DEFAULT 'OTHER' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp (3),
	"ends_at" timestamp (3),
	"price" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'TND' NOT NULL,
	"max_capacity" integer,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"available_from" timestamp (3),
	"available_to" timestamp (3),
	"conditions" jsonb,
	"condition_logic" text DEFAULT 'AND' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"group_label" text,
	"allow_companion" boolean DEFAULT false NOT NULL,
	"included_in_base" boolean DEFAULT false NOT NULL,
	"companion_price" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"max_capacity" integer,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"start_date" timestamp (3) NOT NULL,
	"end_date" timestamp (3) NOT NULL,
	"location" text,
	"status" "EventStatus" DEFAULT 'CLOSED' NOT NULL,
	"banner_url" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" "FormType" DEFAULT 'REGISTRATION' NOT NULL,
	"name" text NOT NULL,
	"schema" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"success_title" text,
	"success_message" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"base_price" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'TND' NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"online_payment_enabled" boolean DEFAULT false NOT NULL,
	"online_payment_url" text,
	"cash_payment_enabled" boolean DEFAULT false NOT NULL,
	"bank_name" text,
	"bank_account_name" text,
	"bank_account_number" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"template_url" text NOT NULL,
	"template_width" integer NOT NULL,
	"template_height" integer NOT NULL,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applicable_roles" "RegistrationRole"[] DEFAULT '{}',
	"access_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"type" "TransactionType" NOT NULL,
	"amount" integer NOT NULL,
	"method" "PaymentMethod",
	"reference" text,
	"note" text,
	"performed_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"event_id" text NOT NULL,
	"form_data" jsonb NOT NULL,
	"submitted_at" timestamp (3) DEFAULT now() NOT NULL,
	"form_schema_version" integer DEFAULT 1 NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"phone" text,
	"reference_number" text,
	"payment_status" "PaymentStatus" DEFAULT 'PENDING' NOT NULL,
	"total_amount" integer NOT NULL,
	"paid_amount" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'TND' NOT NULL,
	"payment_method" "PaymentMethod",
	"payment_reference" text,
	"payment_proof_url" text,
	"price_breakdown" jsonb NOT NULL,
	"base_amount" integer DEFAULT 0 NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"access_amount" integer DEFAULT 0 NOT NULL,
	"sponsorship_code" text,
	"sponsorship_amount" integer DEFAULT 0 NOT NULL,
	"lab_name" text,
	"paid_at" timestamp (3),
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	"last_edited_at" timestamp (3),
	"edit_token" text,
	"link_base_url" text,
	"idempotency_key" text,
	"note" text,
	"registration_role" "RegistrationRole" DEFAULT 'PARTICIPANT' NOT NULL,
	"access_type_ids" text[] DEFAULT '{}',
	"dropped_access_ids" text[] DEFAULT '{}',
	"checked_in_at" timestamp (3),
	"checked_in_by" text
);
--> statement-breakpoint
CREATE TABLE "sponsorship_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"form_id" text NOT NULL,
	"lab_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"form_data" jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsorship_usages" (
	"id" text PRIMARY KEY NOT NULL,
	"sponsorship_id" text NOT NULL,
	"registration_id" text,
	"amount_applied" integer NOT NULL,
	"applied_at" timestamp (3) DEFAULT now() NOT NULL,
	"applied_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsorships" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"event_id" text NOT NULL,
	"code" text NOT NULL,
	"status" "SponsorshipStatus" DEFAULT 'PENDING' NOT NULL,
	"beneficiary_name" text NOT NULL,
	"beneficiary_email" text NOT NULL,
	"beneficiary_phone" text,
	"beneficiary_address" text,
	"covers_base_price" boolean DEFAULT true NOT NULL,
	"covered_access_ids" text[] DEFAULT '{}',
	"total_amount" integer NOT NULL,
	"target_registration_id" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" "AutomaticEmailTrigger",
	"template_id" text,
	"registration_id" text,
	"abstract_id" text,
	"recipient_email" text NOT NULL,
	"recipient_name" text,
	"abstract_trigger" "AbstractEmailTrigger",
	"subject" text NOT NULL,
	"status" "EmailStatus" DEFAULT 'QUEUED' NOT NULL,
	"sendgrid_message_id" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp (3),
	"next_attempt_at" timestamp (3),
	"locked_at" timestamp (3),
	"locked_until" timestamp (3),
	"locked_by" text,
	"context_snapshot" jsonb,
	"queued_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	"sent_at" timestamp (3),
	"delivered_at" timestamp (3),
	"opened_at" timestamp (3),
	"clicked_at" timestamp (3),
	"bounced_at" timestamp (3),
	"failed_at" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"subject" text NOT NULL,
	"content" jsonb NOT NULL,
	"mjml_content" text,
	"html_content" text,
	"plain_content" text,
	"category" "EmailTemplateCategory" NOT NULL,
	"trigger" "AutomaticEmailTrigger",
	"abstract_trigger" "AbstractEmailTrigger",
	"event_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_book_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" "AbstractBookJobStatus" DEFAULT 'PENDING' NOT NULL,
	"storage_key" text,
	"error_message" text,
	"included_count" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_attempt_at" timestamp (3),
	"next_attempt_at" timestamp (3),
	"locked_at" timestamp (3),
	"locked_until" timestamp (3),
	"locked_by" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"started_at" timestamp (3),
	"completed_at" timestamp (3),
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_code_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"theme_id" text NOT NULL,
	"final_type" "AbstractFinalType" NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_code_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"final_type" "AbstractFinalType" NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_committee_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_config" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"submission_mode" "AbstractSubmissionMode" DEFAULT 'FREE_TEXT' NOT NULL,
	"global_word_limit" integer DEFAULT 500,
	"section_word_limits" jsonb,
	"submission_start_at" timestamp (3),
	"submission_deadline" timestamp (3),
	"editing_deadline" timestamp (3),
	"scoring_start_at" timestamp (3),
	"scoring_deadline" timestamp (3),
	"final_file_deadline" timestamp (3),
	"editing_enabled" boolean DEFAULT false NOT NULL,
	"comments_enabled" boolean DEFAULT false NOT NULL,
	"comments_sent_to_author" boolean DEFAULT false NOT NULL,
	"final_file_upload_enabled" boolean DEFAULT false NOT NULL,
	"reviewers_per_abstract" integer DEFAULT 2 NOT NULL,
	"divergence_threshold" integer DEFAULT 6 NOT NULL,
	"max_themes_per_abstract" integer,
	"distribute_by_theme" boolean DEFAULT false NOT NULL,
	"mode_locked" boolean DEFAULT false NOT NULL,
	"book_font_family" text DEFAULT 'Arial' NOT NULL,
	"book_font_size" integer DEFAULT 11 NOT NULL,
	"book_line_spacing" double precision DEFAULT 1.5 NOT NULL,
	"book_order" "AbstractBookOrder" DEFAULT 'BY_CODE' NOT NULL,
	"book_include_author_names" boolean DEFAULT true NOT NULL,
	"additional_fields_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_reviewer_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"theme_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"abstract_id" text NOT NULL,
	"event_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"score" double precision,
	"comment" text,
	"scored_at" timestamp (3),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"abstract_id" text NOT NULL,
	"revision_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"edited_by" text NOT NULL,
	"edited_ip_address" text,
	"content" jsonb NOT NULL,
	"co_authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additional_fields_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_theme_links" (
	"id" text PRIMARY KEY NOT NULL,
	"abstract_id" text NOT NULL,
	"theme_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstract_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abstracts" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"author_first_name" text NOT NULL,
	"author_last_name" text NOT NULL,
	"author_affiliation" text,
	"author_email" text NOT NULL,
	"author_email_normalized" text,
	"author_phone" text NOT NULL,
	"requested_type" "AbstractRequestedType" NOT NULL,
	"content" jsonb NOT NULL,
	"co_authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additional_fields_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"code" text,
	"code_number" integer,
	"status" "AbstractStatus" DEFAULT 'SUBMITTED' NOT NULL,
	"content_version" integer DEFAULT 1 NOT NULL,
	"final_type" "AbstractFinalType",
	"average_score" double precision,
	"review_count" integer DEFAULT 0 NOT NULL,
	"presented_at" timestamp (3),
	"presented_by" text,
	"final_file_key" text,
	"final_file_kind" "AbstractFileKind",
	"final_file_size" integer,
	"final_file_uploaded_at" timestamp (3),
	"edit_token" text NOT NULL,
	"last_edited_at" timestamp (3),
	"link_base_url" text,
	"registration_id" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"performed_by" text,
	"performed_at" timestamp (3) DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"aggregate_type" text,
	"aggregate_id" text,
	"client_id" text,
	"event_id" text,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_attempt_at" timestamp (3),
	"next_attempt_at" timestamp (3),
	"locked_at" timestamp (3),
	"locked_until" timestamp (3),
	"locked_by" text,
	"error_message" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	"processed_at" timestamp (3)
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "access_check_ins" ADD CONSTRAINT "access_check_ins_access_id_event_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."event_access"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_A_event_access_id_fk" FOREIGN KEY ("A") REFERENCES "public"."event_access"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "_AccessPrerequisites" ADD CONSTRAINT "_AccessPrerequisites_B_event_access_id_fk" FOREIGN KEY ("B") REFERENCES "public"."event_access"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "event_access" ADD CONSTRAINT "event_access_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "event_pricing" ADD CONSTRAINT "event_pricing_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_access_id_event_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."event_access"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorship_batches" ADD CONSTRAINT "sponsorship_batches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorship_batches" ADD CONSTRAINT "sponsorship_batches_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorship_usages" ADD CONSTRAINT "sponsorship_usages_sponsorship_id_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."sponsorships"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorship_usages" ADD CONSTRAINT "sponsorship_usages_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_batch_id_sponsorship_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."sponsorship_batches"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_abstract_id_abstracts_id_fk" FOREIGN KEY ("abstract_id") REFERENCES "public"."abstracts"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_book_jobs" ADD CONSTRAINT "abstract_book_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_code_counters" ADD CONSTRAINT "abstract_code_counters_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_code_counters" ADD CONSTRAINT "abstract_code_counters_theme_id_abstract_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."abstract_themes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_config" ADD CONSTRAINT "abstract_config_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_theme_id_abstract_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."abstract_themes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_abstract_id_abstracts_id_fk" FOREIGN KEY ("abstract_id") REFERENCES "public"."abstracts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_revisions" ADD CONSTRAINT "abstract_revisions_abstract_id_abstracts_id_fk" FOREIGN KEY ("abstract_id") REFERENCES "public"."abstracts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_abstract_id_abstracts_id_fk" FOREIGN KEY ("abstract_id") REFERENCES "public"."abstracts"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_theme_links" ADD CONSTRAINT "abstract_theme_links_theme_id_abstract_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."abstract_themes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstract_themes" ADD CONSTRAINT "abstract_themes_config_id_abstract_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."abstract_config"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "abstracts" ADD CONSTRAINT "abstracts_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_client_id_idx" ON "users" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "users_active_role_idx" ON "users" USING btree ("active","role");--> statement-breakpoint
CREATE INDEX "users_client_id_role_idx" ON "users" USING btree ("client_id","role");--> statement-breakpoint
CREATE INDEX "access_check_ins_access_id_idx" ON "access_check_ins" USING btree ("access_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_check_ins_registration_id_access_id_key" ON "access_check_ins" USING btree ("registration_id","access_id");--> statement-breakpoint
CREATE UNIQUE INDEX "_AccessPrerequisites_AB_unique" ON "_AccessPrerequisites" USING btree ("A","B");--> statement-breakpoint
CREATE INDEX "_AccessPrerequisites_B_index" ON "_AccessPrerequisites" USING btree ("B");--> statement-breakpoint
CREATE INDEX "event_access_event_id_starts_at_idx" ON "event_access" USING btree ("event_id","starts_at");--> statement-breakpoint
CREATE INDEX "event_access_event_id_type_idx" ON "event_access" USING btree ("event_id","type");--> statement-breakpoint
CREATE INDEX "event_access_event_id_active_idx" ON "event_access" USING btree ("event_id","active");--> statement-breakpoint
CREATE INDEX "event_access_event_id_type_active_idx" ON "event_access" USING btree ("event_id","type","active");--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_key" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_client_id_status_idx" ON "events" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "forms_event_id_idx" ON "forms" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_event_id_type_key" ON "forms" USING btree ("event_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "event_pricing_event_id_key" ON "event_pricing" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "certificate_templates_event_id_idx" ON "certificate_templates" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "payment_transaction_registration_id_idx" ON "payment_transaction" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_reference_number_key" ON "registrations" USING btree ("reference_number");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_edit_token_key" ON "registrations" USING btree ("edit_token");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_idempotency_key_key" ON "registrations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "registrations_event_id_payment_status_idx" ON "registrations" USING btree ("event_id","payment_status");--> statement-breakpoint
CREATE INDEX "registrations_event_id_submitted_at_idx" ON "registrations" USING btree ("event_id","submitted_at");--> statement-breakpoint
CREATE INDEX "registrations_form_id_idx" ON "registrations" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "registrations_email_idx" ON "registrations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "registrations_sponsorship_code_idx" ON "registrations" USING btree ("sponsorship_code");--> statement-breakpoint
CREATE INDEX "registrations_payment_status_updated_at_idx" ON "registrations" USING btree ("payment_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_email_form_id_key" ON "registrations" USING btree ("email","form_id");--> statement-breakpoint
CREATE INDEX "sponsorship_batches_event_id_idx" ON "sponsorship_batches" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sponsorship_batches_email_idx" ON "sponsorship_batches" USING btree ("email");--> statement-breakpoint
CREATE INDEX "sponsorship_usages_registration_id_idx" ON "sponsorship_usages" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsorship_usages_sponsorship_id_registration_id_key" ON "sponsorship_usages" USING btree ("sponsorship_id","registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsorships_code_key" ON "sponsorships" USING btree ("code");--> statement-breakpoint
CREATE INDEX "sponsorships_event_id_idx" ON "sponsorships" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sponsorships_batch_id_idx" ON "sponsorships" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sponsorships_event_id_status_idx" ON "sponsorships" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "sponsorships_status_idx" ON "sponsorships" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sponsorships_batch_id_status_idx" ON "sponsorships" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "email_logs_registration_id_idx" ON "email_logs" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "email_logs_abstract_id_idx" ON "email_logs" USING btree ("abstract_id");--> statement-breakpoint
CREATE INDEX "email_logs_abstract_id_abstract_trigger_queued_at_idx" ON "email_logs" USING btree ("abstract_id","abstract_trigger","queued_at");--> statement-breakpoint
CREATE INDEX "email_logs_status_queued_at_idx" ON "email_logs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "email_logs_status_retry_count_idx" ON "email_logs" USING btree ("status","retry_count");--> statement-breakpoint
CREATE INDEX "email_logs_status_next_attempt_at_queued_at_idx" ON "email_logs" USING btree ("status","next_attempt_at","queued_at");--> statement-breakpoint
CREATE INDEX "email_logs_status_locked_until_idx" ON "email_logs" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "email_logs_locked_by_idx" ON "email_logs" USING btree ("locked_by");--> statement-breakpoint
CREATE INDEX "email_logs_recipient_email_idx" ON "email_logs" USING btree ("recipient_email");--> statement-breakpoint
CREATE INDEX "email_logs_sendgrid_message_id_idx" ON "email_logs" USING btree ("sendgrid_message_id");--> statement-breakpoint
CREATE INDEX "email_logs_trigger_queued_at_idx" ON "email_logs" USING btree ("trigger","queued_at");--> statement-breakpoint
CREATE INDEX "email_templates_client_id_category_idx" ON "email_templates" USING btree ("client_id","category");--> statement-breakpoint
CREATE INDEX "email_templates_client_id_trigger_idx" ON "email_templates" USING btree ("client_id","trigger");--> statement-breakpoint
CREATE INDEX "email_templates_event_id_idx" ON "email_templates" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "abstract_book_jobs_event_id_created_at_idx" ON "abstract_book_jobs" USING btree ("event_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "abstract_book_jobs_status_created_at_idx" ON "abstract_book_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "abstract_book_jobs_status_next_attempt_at_created_at_idx" ON "abstract_book_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "abstract_book_jobs_status_locked_until_idx" ON "abstract_book_jobs" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "abstract_book_jobs_locked_by_idx" ON "abstract_book_jobs" USING btree ("locked_by");--> statement-breakpoint
CREATE INDEX "abstract_code_counters_theme_id_idx" ON "abstract_code_counters" USING btree ("theme_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_code_counters_event_id_theme_id_final_type_key" ON "abstract_code_counters" USING btree ("event_id","theme_id","final_type");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_code_sequences_final_type_key" ON "abstract_code_sequences" USING btree ("final_type");--> statement-breakpoint
CREATE INDEX "abstract_committee_memberships_event_id_active_idx" ON "abstract_committee_memberships" USING btree ("event_id","active");--> statement-breakpoint
CREATE INDEX "abstract_committee_memberships_user_id_active_idx" ON "abstract_committee_memberships" USING btree ("user_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_committee_memberships_user_id_event_id_key" ON "abstract_committee_memberships" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_config_event_id_key" ON "abstract_config" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "abstract_reviewer_themes_event_id_theme_id_idx" ON "abstract_reviewer_themes" USING btree ("event_id","theme_id");--> statement-breakpoint
CREATE INDEX "abstract_reviewer_themes_user_id_event_id_active_idx" ON "abstract_reviewer_themes" USING btree ("user_id","event_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_reviewer_themes_user_id_event_id_theme_id_key" ON "abstract_reviewer_themes" USING btree ("user_id","event_id","theme_id");--> statement-breakpoint
CREATE INDEX "abstract_reviews_reviewer_id_event_id_active_scored_at_idx" ON "abstract_reviews" USING btree ("reviewer_id","event_id","active","scored_at");--> statement-breakpoint
CREATE INDEX "abstract_reviews_event_id_active_scored_at_idx" ON "abstract_reviews" USING btree ("event_id","active","scored_at");--> statement-breakpoint
CREATE INDEX "abstract_reviews_abstract_id_active_idx" ON "abstract_reviews" USING btree ("abstract_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_reviews_abstract_id_reviewer_id_key" ON "abstract_reviews" USING btree ("abstract_id","reviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_revisions_abstract_id_revision_no_key" ON "abstract_revisions" USING btree ("abstract_id","revision_no");--> statement-breakpoint
CREATE INDEX "abstract_theme_links_theme_id_idx" ON "abstract_theme_links" USING btree ("theme_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abstract_theme_links_abstract_id_theme_id_key" ON "abstract_theme_links" USING btree ("abstract_id","theme_id");--> statement-breakpoint
CREATE INDEX "abstract_themes_config_id_active_idx" ON "abstract_themes" USING btree ("config_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "abstracts_edit_token_key" ON "abstracts" USING btree ("edit_token");--> statement-breakpoint
CREATE INDEX "abstracts_event_id_status_idx" ON "abstracts" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "abstracts_event_id_created_at_idx" ON "abstracts" USING btree ("event_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "abstracts_author_email_idx" ON "abstracts" USING btree ("author_email");--> statement-breakpoint
CREATE INDEX "abstracts_event_id_author_email_normalized_idx" ON "abstracts" USING btree ("event_id","author_email_normalized");--> statement-breakpoint
CREATE INDEX "abstracts_registration_id_idx" ON "abstracts" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abstracts_event_id_code_key" ON "abstracts" USING btree ("event_id","code");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs" USING btree ("performed_by");--> statement-breakpoint
CREATE INDEX "audit_logs_performed_at_idx" ON "audit_logs" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx" ON "outbox_events" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_status_locked_until_idx" ON "outbox_events" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "outbox_events_locked_by_idx" ON "outbox_events" USING btree ("locked_by");--> statement-breakpoint
CREATE INDEX "outbox_events_type_idx" ON "outbox_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "outbox_events_client_id_event_id_idx" ON "outbox_events" USING btree ("client_id","event_id");
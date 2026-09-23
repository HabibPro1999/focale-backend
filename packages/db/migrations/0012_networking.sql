-- migrate: transaction per-file
CREATE TABLE "networking_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_availability" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_configs" (
	"event_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_a_id" text NOT NULL,
	"profile_b_id" text NOT NULL,
	"read_a_at" timestamp (3) with time zone,
	"read_b_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text,
	"email" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"last_error" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_interests" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"ends_at" timestamp (3) with time zone NOT NULL,
	"table_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"proposed_starts_at" timestamp (3) with time zone,
	"proposal_by" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"requester_checked_in_at" timestamp (3) with time zone,
	"recipient_checked_in_at" timestamp (3) with time zone,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"client_message_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"registration_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"job_title" text DEFAULT '' NOT NULL,
	"sector" text DEFAULT '' NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"website" text,
	"photo_url" text,
	"interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"offers" text DEFAULT '' NOT NULL,
	"seeks" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"meetings_enabled" boolean DEFAULT true NOT NULL,
	"email_preference" text DEFAULT 'IMMEDIATE' NOT NULL,
	"language" text DEFAULT 'fr' NOT NULL,
	"consent" boolean DEFAULT true NOT NULL,
	"availability_set" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp (3) with time zone,
	"last_active_at" timestamp (3) with time zone,
	"withdrawn_at" timestamp (3) with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"stand_table_id" text,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"expiration_time" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"message_id" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"note" text,
	"resolved_by" text,
	"resolved_at" timestamp (3) with time zone,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"meeting_id" text NOT NULL,
	"resource_key" text NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "networking_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"capacity" integer DEFAULT 2 NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"kind" text DEFAULT 'TABLE' NOT NULL,
	"owner_profile_id" text,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "networking_audit" ADD CONSTRAINT "networking_audit_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_availability" ADD CONSTRAINT "networking_availability_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_availability" ADD CONSTRAINT "networking_availability_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_blocks" ADD CONSTRAINT "networking_blocks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_blocks" ADD CONSTRAINT "networking_blocks_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_blocks" ADD CONSTRAINT "networking_blocks_target_id_networking_profiles_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_challenges" ADD CONSTRAINT "networking_challenges_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_configs" ADD CONSTRAINT "networking_configs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_connections" ADD CONSTRAINT "networking_connections_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_connections" ADD CONSTRAINT "networking_connections_profile_a_id_networking_profiles_id_fk" FOREIGN KEY ("profile_a_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_connections" ADD CONSTRAINT "networking_connections_profile_b_id_networking_profiles_id_fk" FOREIGN KEY ("profile_b_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_deliveries" ADD CONSTRAINT "networking_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_deliveries" ADD CONSTRAINT "networking_deliveries_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_interests" ADD CONSTRAINT "networking_interests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_interests" ADD CONSTRAINT "networking_interests_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_interests" ADD CONSTRAINT "networking_interests_target_id_networking_profiles_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_meetings" ADD CONSTRAINT "networking_meetings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_meetings" ADD CONSTRAINT "networking_meetings_requester_id_networking_profiles_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_meetings" ADD CONSTRAINT "networking_meetings_recipient_id_networking_profiles_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_meetings" ADD CONSTRAINT "networking_meetings_table_id_networking_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."networking_tables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_messages" ADD CONSTRAINT "networking_messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_messages" ADD CONSTRAINT "networking_messages_connection_id_networking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."networking_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_messages" ADD CONSTRAINT "networking_messages_sender_id_networking_profiles_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_notifications" ADD CONSTRAINT "networking_notifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_notifications" ADD CONSTRAINT "networking_notifications_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_profiles" ADD CONSTRAINT "networking_profiles_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_profiles" ADD CONSTRAINT "networking_profiles_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_push_subscriptions" ADD CONSTRAINT "networking_push_subscriptions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_push_subscriptions" ADD CONSTRAINT "networking_push_subscriptions_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reports" ADD CONSTRAINT "networking_reports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reports" ADD CONSTRAINT "networking_reports_reporter_id_networking_profiles_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reports" ADD CONSTRAINT "networking_reports_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reports" ADD CONSTRAINT "networking_reports_message_id_networking_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."networking_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reservations" ADD CONSTRAINT "networking_reservations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_reservations" ADD CONSTRAINT "networking_reservations_meeting_id_networking_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."networking_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_sessions" ADD CONSTRAINT "networking_sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_sessions" ADD CONSTRAINT "networking_sessions_profile_id_networking_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_tables" ADD CONSTRAINT "networking_tables_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networking_tables" ADD CONSTRAINT "networking_tables_owner_profile_id_networking_profiles_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."networking_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "networking_audit_event_created_idx" ON "networking_audit" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_availability_slot_key" ON "networking_availability" USING btree ("profile_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_blocks_pair_key" ON "networking_blocks" USING btree ("event_id","profile_id","target_id");--> statement-breakpoint
CREATE INDEX "networking_challenges_email_created_idx" ON "networking_challenges" USING btree ("event_id","email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_connections_pair_key" ON "networking_connections" USING btree ("event_id","profile_a_id","profile_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_deliveries_dedupe_key" ON "networking_deliveries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "networking_deliveries_pending_idx" ON "networking_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_interests_pair_key" ON "networking_interests" USING btree ("event_id","profile_id","target_id");--> statement-breakpoint
CREATE INDEX "networking_meetings_event_starts_idx" ON "networking_meetings" USING btree ("event_id","starts_at");--> statement-breakpoint
CREATE INDEX "networking_meetings_pending_idx" ON "networking_meetings" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_messages_client_key" ON "networking_messages" USING btree ("sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "networking_messages_connection_created_idx" ON "networking_messages" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "networking_notifications_profile_created_idx" ON "networking_notifications" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_profiles_registration_key" ON "networking_profiles" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "networking_profiles_event_status_idx" ON "networking_profiles" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "networking_profiles_event_email_idx" ON "networking_profiles" USING btree ("event_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_push_endpoint_key" ON "networking_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "networking_reports_event_status_idx" ON "networking_reports" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_reservations_resource_slot_key" ON "networking_reservations" USING btree ("event_id","resource_key","starts_at");--> statement-breakpoint
CREATE INDEX "networking_reservations_meeting_idx" ON "networking_reservations" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_sessions_token_key" ON "networking_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "networking_sessions_profile_idx" ON "networking_sessions" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "networking_tables_event_name_key" ON "networking_tables" USING btree ("event_id","name");
-- Domain invariants remain enforced even outside the application.
ALTER TABLE networking_connections ADD CONSTRAINT networking_connections_ordered_pair CHECK (profile_a_id < profile_b_id);
ALTER TABLE networking_interests ADD CONSTRAINT networking_interests_no_self CHECK (profile_id <> target_id);
ALTER TABLE networking_blocks ADD CONSTRAINT networking_blocks_no_self CHECK (profile_id <> target_id);
ALTER TABLE networking_meetings ADD CONSTRAINT networking_meetings_valid_pair CHECK (requester_id <> recipient_id);
ALTER TABLE networking_meetings ADD CONSTRAINT networking_meetings_valid_interval CHECK (ends_at > starts_at);
ALTER TABLE networking_tables ADD CONSTRAINT networking_tables_minimum_capacity CHECK (capacity >= 2);
ALTER TABLE networking_messages ADD CONSTRAINT networking_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 1000);

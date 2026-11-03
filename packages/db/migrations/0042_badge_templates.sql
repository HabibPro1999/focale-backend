-- migrate: transaction per-statement
-- migrate: idempotent
-- An event's registrant badge designs (page size in millimetres, optional
-- background image, text and QR zones), rendered as a PDF for print and as an
-- email attachment. Expand-only: a new table, nothing existing changes.
-- One statement per transaction: CockroachDB must commit the table before the
-- index on it.
CREATE TABLE IF NOT EXISTS "badge_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"width_mm" numeric(6, 2) NOT NULL,
	"height_mm" numeric(6, 2) NOT NULL,
	"background_url" text,
	"background_width" integer,
	"background_height" integer,
	"render_image_key" text,
	"render_image_width" integer,
	"render_image_height" integer,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) NOT NULL,
	CONSTRAINT "badge_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "badge_templates_event_id_idx" ON "badge_templates" USING btree ("event_id");

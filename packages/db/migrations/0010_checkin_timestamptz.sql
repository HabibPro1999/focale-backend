-- migrate: transaction per-statement
-- migrate: idempotent
-- migrate: verify SELECT COUNT(*) = 2 AS passed FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'registrations' AND column_name = 'checked_in_at') OR (table_name = 'access_check_ins' AND column_name = 'checked_in_at')) AND lower(data_type) = 'timestamp with time zone' AND datetime_precision = 3
-- Legacy production migrations already use timestamptz. Align fresh Nest
-- databases too, interpreting the old naive timestamps as UTC.
SET TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "registrations" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);
--> statement-breakpoint
ALTER TABLE "access_check_ins" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);

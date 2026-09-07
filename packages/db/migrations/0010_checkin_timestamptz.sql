-- Legacy production migrations already use timestamptz. Align fresh Nest
-- databases too, interpreting the old naive timestamps as UTC.
SET TIME ZONE 'UTC';
ALTER TABLE "registrations" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);
ALTER TABLE "access_check_ins" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);

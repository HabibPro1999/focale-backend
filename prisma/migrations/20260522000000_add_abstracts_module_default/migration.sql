-- Add 'abstracts' to the default for enabled_modules column.
ALTER TABLE "clients" ALTER COLUMN "enabled_modules" SET DEFAULT ARRAY['pricing', 'registrations', 'sponsorships', 'emails', 'certificates', 'abstracts']::STRING[];

-- Backfill existing clients: add 'abstracts' to any client that doesn't already have it.
UPDATE "clients"
SET "enabled_modules" = array_append("enabled_modules", 'abstracts')
WHERE NOT ('abstracts' = ANY("enabled_modules"));

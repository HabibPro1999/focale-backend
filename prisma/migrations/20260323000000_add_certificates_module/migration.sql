-- Add 'certificates' to the default for enabled_modules column
ALTER TABLE "clients" ALTER COLUMN "enabled_modules" SET DEFAULT ARRAY['pricing', 'registrations', 'sponsorships', 'emails', 'certificates']::STRING[];

-- Backfill existing clients: add 'certificates' to any client that doesn't already have it
UPDATE "clients"
SET "enabled_modules" = array_append("enabled_modules", 'certificates')
WHERE NOT ('certificates' = ANY("enabled_modules"));

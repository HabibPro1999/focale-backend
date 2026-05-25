-- Normalize equivalent Cockroach timestamp defaults so dev and prod introspect identically.

ALTER TABLE "access_check_ins"
  ALTER COLUMN "checked_in_at" SET DEFAULT now();

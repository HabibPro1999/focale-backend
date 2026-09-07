ALTER TABLE "forms"
  ADD COLUMN IF NOT EXISTS "success_translations" JSONB;

ALTER TABLE "abstract_themes"
  ADD COLUMN IF NOT EXISTS "translations" JSONB;

ALTER TABLE "abstract_config"
  ADD COLUMN IF NOT EXISTS "languages" JSONB;

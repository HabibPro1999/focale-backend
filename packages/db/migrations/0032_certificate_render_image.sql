-- migrate: transaction per-statement
-- migrate: idempotent
-- 3.8: the certificate render image. Uploading a template image also stores a
-- flattened JPEG copy (at most 3508 px on the long edge) that the worker embeds
-- with pdf-lib's embedJpg instead of decoding the original PNG in JavaScript
-- for every certificate. render_image_key is the storage key of that copy;
-- width and height are its pixel size. All three stay NULL on templates
-- uploaded before 3.8 (the renderer falls back to the original image) until
-- the backfill-certificate-renders script fills them.
-- One statement per transaction: CockroachDB must commit each schema change
-- before a later statement relies on it.
ALTER TABLE "certificate_templates" ADD COLUMN IF NOT EXISTS "render_image_key" text;
--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD COLUMN IF NOT EXISTS "render_image_width" integer;
--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD COLUMN IF NOT EXISTS "render_image_height" integer;

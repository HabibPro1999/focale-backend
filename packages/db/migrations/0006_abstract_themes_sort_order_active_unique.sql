-- Hand-written, same convention as 0001_raw_indexes.sql (not tracked by
-- drizzle-kit / meta/_journal.json).
--
-- Active-theme sortOrder uniqueness. Abstract codes embed the theme's
-- sortOrder (OC<sortOrder>-NN), so two ACTIVE themes sharing a sortOrder
-- collide on the unique (event_id, code) at finalize time. Application code
-- pre-checks (assertSortOrderAvailable) but is check-then-act per request:
-- concurrent reorders/reactivations could slip duplicates through. This index
-- is the authoritative backstop — a losing writer now gets 23505 (mapped to
-- 409 CONFLICT by the API's pg-error filter) instead of silently corrupting
-- code numbering.
--
-- Repair existing duplicates first: within each (config_id, sort_order) group
-- of ACTIVE themes, the theme with issued codes (abstract_code_counters
-- last_value) keeps its slot — moving it would break the OC<sortOrder>-NN ↔
-- theme correlation of already-issued codes — and the others are bumped to
-- fresh slots above the config's current max.
WITH issued AS (
  SELECT t."id", COALESCE(SUM(acc."last_value"), 0) AS n
  FROM "abstract_themes" t
  LEFT JOIN "abstract_code_counters" acc ON acc."theme_id" = t."id"
  GROUP BY t."id"
),
ranked AS (
  SELECT t."id", t."config_id", t."sort_order",
         ROW_NUMBER() OVER (
           PARTITION BY t."config_id", t."sort_order"
           ORDER BY i.n DESC, t."created_at", t."id"
         ) AS rn
  FROM "abstract_themes" t
  JOIN issued i ON i."id" = t."id"
  WHERE t."active"
),
to_bump AS (
  SELECT "id", "config_id",
         ROW_NUMBER() OVER (PARTITION BY "config_id" ORDER BY "sort_order", "id") AS k
  FROM ranked
  WHERE rn > 1
),
maxes AS (
  SELECT "config_id", MAX("sort_order") AS max_so
  FROM "abstract_themes"
  GROUP BY "config_id"
)
UPDATE "abstract_themes" t
SET "sort_order" = m.max_so + b.k, "updated_at" = now()
FROM to_bump b
JOIN maxes m ON m."config_id" = b."config_id"
WHERE t."id" = b."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "abstract_themes_config_id_sort_order_active_key"
  ON "abstract_themes" ("config_id", "sort_order")
  WHERE "active";

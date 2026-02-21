-- Normalize conditionLogic values from uppercase to lowercase

-- 1. EventAccess: condition_logic column
UPDATE "event_access"
SET "condition_logic" = LOWER("condition_logic")
WHERE "condition_logic" != LOWER("condition_logic");

-- 2. EventPricing: conditionLogic inside rules JSONB array
-- Each rule object in the rules array may have a conditionLogic field
UPDATE "event_pricing"
SET "rules" = (
  SELECT jsonb_agg(
    CASE
      WHEN rule ? 'conditionLogic'
      THEN jsonb_set(rule, '{conditionLogic}', to_jsonb(LOWER(rule->>'conditionLogic')))
      ELSE rule
    END
  )
  FROM jsonb_array_elements("rules") AS rule
)
WHERE "rules" != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("rules") AS r
    WHERE r->>'conditionLogic' IS NOT NULL
      AND r->>'conditionLogic' != LOWER(r->>'conditionLogic')
  );

-- 3. Update Prisma schema default (already done in schema.prisma)
-- conditionLogic @default("and") is set in the Prisma schema
ALTER TABLE "event_access" ALTER COLUMN "condition_logic" SET DEFAULT 'and';

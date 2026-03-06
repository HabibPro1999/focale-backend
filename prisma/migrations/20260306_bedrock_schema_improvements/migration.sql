-- Step 1: Backfill NULL nominal_amount values with 0
UPDATE "sponsorships" SET "nominal_amount" = 0 WHERE "nominal_amount" IS NULL;

-- Step 2: Set default and make non-nullable (no data loss — all NULLs already backfilled)
ALTER TABLE "sponsorships" ALTER COLUMN "nominal_amount" SET DEFAULT 0;
ALTER TABLE "sponsorships" ALTER COLUMN "nominal_amount" SET NOT NULL;

-- Step 3: Create the ConditionLogic enum
CREATE TYPE "ConditionLogic" AS ENUM ('and', 'or');

-- Step 4: CockroachDB-compatible string→enum conversion (add new, copy, drop old, rename)
ALTER TABLE "event_access" ADD COLUMN "condition_logic_new" "ConditionLogic" DEFAULT 'and'::"ConditionLogic";
UPDATE "event_access" SET "condition_logic_new" = "condition_logic"::"ConditionLogic";
ALTER TABLE "event_access" DROP COLUMN "condition_logic";
ALTER TABLE "event_access" RENAME COLUMN "condition_logic_new" TO "condition_logic";
ALTER TABLE "event_access" ALTER COLUMN "condition_logic" SET DEFAULT 'and'::"ConditionLogic";
ALTER TABLE "event_access" ALTER COLUMN "condition_logic" SET NOT NULL;

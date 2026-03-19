-- ============================================================================
-- Alignment migration: bring the develop database in sync with schema.prisma
--
-- Background: the develop branch was reset to the main level after being ahead.
-- The develop database retained schema changes from those removed migrations.
-- This migration reconciles the diff between the actual DB state and
-- the current schema.prisma.
-- ============================================================================

-- Add missing enum values
-- (These were expected by the schema but never added to the develop DB)
ALTER TYPE "AccessType" ADD VALUE IF NOT EXISTS 'ADDON';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'LAB_SPONSORSHIP';

-- Add missing columns to event_access
ALTER TABLE "event_access" ADD COLUMN IF NOT EXISTS "companion_price" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "event_access" ADD COLUMN IF NOT EXISTS "included_in_base" BOOL NOT NULL DEFAULT false;

-- Fix condition_logic column: was stored as ConditionLogic enum type, schema expects STRING.
-- Drop and re-add preserves the DEFAULT 'AND' for all rows.
ALTER TABLE "event_access" DROP COLUMN IF EXISTS "condition_logic";
ALTER TABLE "event_access" ADD COLUMN "condition_logic" STRING NOT NULL DEFAULT 'AND';

-- Add missing column to event_pricing
ALTER TABLE "event_pricing" ADD COLUMN IF NOT EXISTS "cash_payment_enabled" BOOL NOT NULL DEFAULT false;

-- Add missing column to registrations
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "lab_name" STRING;

-- Drop the nominal_amount column from sponsorships
-- (was added in a develop-only migration, not present in current schema)
ALTER TABLE "sponsorships" DROP COLUMN IF EXISTS "nominal_amount";

-- Drop the ConditionLogic enum type (replaced by plain STRING on condition_logic column)
DROP TYPE IF EXISTS "ConditionLogic";

-- ============================================================================
-- FOCALE OS: Dev → Prod Migration
-- Date: 2026-04-03
-- Target: Production CockroachDB (mimic-plover-12397)
-- Registrations: 581 rows across 2 live events
-- ============================================================================
-- IMPORTANT: Run prisma db push FIRST to sync schema (enums, tables, columns)
-- Then run this SQL for data migration.
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 1: Verify pre-migration state
-- ============================================================================

-- Expected: 581 total registrations
-- SELECT COUNT(*) FROM registrations;
-- SELECT payment_status, COUNT(*) FROM registrations GROUP BY payment_status;

-- ============================================================================
-- STEP 2: Reclassify payment statuses
-- ============================================================================

-- 2a. PAID + LAB_SPONSORSHIP + fully sponsored → SPONSORED
-- These are registrations covered by sponsorship codes, not cash payments.
-- Expected: 250 rows (all AMGLS event)
UPDATE registrations
SET payment_status = 'SPONSORED'
WHERE payment_status = 'PAID'
  AND payment_method = 'LAB_SPONSORSHIP'
  AND sponsorship_amount >= total_amount
  AND sponsorship_amount > 0;

-- 2b. PENDING + LAB_SPONSORSHIP + partial sponsorship → PARTIAL
-- These have linked sponsorships but still owe a remainder (20-50 TND each).
-- Expected: 15 rows (all AMGLS event)
UPDATE registrations
SET payment_status = 'PARTIAL'
WHERE payment_status = 'PENDING'
  AND payment_method = 'LAB_SPONSORSHIP'
  AND sponsorship_amount > 0
  AND sponsorship_amount < total_amount;

-- 2c. WAIVED + LAB_SPONSORSHIP + no actual sponsorship → PENDING
-- These are lab sponsorship CLAIMS that were never confirmed.
-- The doctor said "my lab pays" but no sponsorship code was linked.
-- All 35 are from the AMOMS event. They have lab_name set but no sponsorship.
-- Expected: 35 rows
UPDATE registrations
SET payment_status = 'PENDING'
WHERE payment_status = 'WAIVED'
  AND payment_method = 'LAB_SPONSORSHIP'
  AND sponsorship_amount = 0;

-- 2d. Sami Hmid anomaly → WAIVED
-- This registration is PAID with no method, no paid_amount, no sponsorship.
-- Someone manually marked him as PAID (admin decision). Treating as a waiver.
-- Expected: 1 row
UPDATE registrations
SET payment_status = 'WAIVED'
WHERE id = '62823c18-eb0f-43e2-8860-c653ece49c34'
  AND payment_status = 'PAID'
  AND paid_amount = 0
  AND sponsorship_amount = 0;

-- ============================================================================
-- STEP 3: Backfill PaymentTransaction ledger
-- ============================================================================

-- Create immutable transaction records for all existing confirmed payments.
-- These are the 14 bank transfer registrations with paid_amount > 0.
INSERT INTO payment_transaction (id, registration_id, type, amount, method, note, created_at)
SELECT gen_random_uuid(), id, 'PAYMENT', paid_amount, payment_method,
       'Backfilled from legacy paidAmount', paid_at
FROM registrations
WHERE paid_amount > 0 AND paid_at IS NOT NULL;

-- ============================================================================
-- STEP 4: Update client modules
-- ============================================================================

-- Add 'certificates' to enabled_modules for all clients that don't have it
UPDATE clients
SET enabled_modules = array_append(enabled_modules, 'certificates')
WHERE NOT ('certificates' = ANY(enabled_modules));

-- ============================================================================
-- STEP 5: Backfill paidCount on access items
-- ============================================================================
-- paidCount tracks how many settled registrations hold each access item.
-- Used for capacity enforcement: only settled registrations consume capacity.
--
-- Rules:
--   PAID / SPONSORED / WAIVED → ALL access items count
--   PARTIAL → only access items in the sponsorship's coveredAccessIds count
--   PENDING / VERIFYING / REFUNDED → nothing counts

-- 5a. PAID + SPONSORED + WAIVED → all their access items
WITH settled_access AS (
  SELECT unnest(r.access_type_ids) AS access_id, 1 AS cnt
  FROM registrations r
  WHERE r.payment_status IN ('PAID', 'SPONSORED', 'WAIVED')
    AND array_length(r.access_type_ids, 1) > 0
),
settled_counts AS (
  SELECT access_id, SUM(cnt) AS total
  FROM settled_access
  GROUP BY access_id
)
UPDATE event_access ea
SET paid_count = sc.total
FROM settled_counts sc
WHERE ea.id = sc.access_id;

-- 5b. PARTIAL → only coveredAccessIds from linked sponsorships
WITH partial_covered AS (
  SELECT unnest(s.covered_access_ids) AS access_id, 1 AS cnt
  FROM sponsorship_usages su
  JOIN sponsorships s ON su.sponsorship_id = s.id
  JOIN registrations r ON su.registration_id = r.id
  WHERE r.payment_status = 'PARTIAL'
    AND array_length(s.covered_access_ids, 1) > 0
),
partial_counts AS (
  SELECT access_id, SUM(cnt) AS total
  FROM partial_covered
  GROUP BY access_id
)
UPDATE event_access ea
SET paid_count = ea.paid_count + pc.total
FROM partial_counts pc
WHERE ea.id = pc.access_id;

-- ============================================================================
-- STEP 6: Post-migration verification
-- ============================================================================

-- Run these queries to verify:
--
-- Total must still be 581:
--   SELECT COUNT(*) FROM registrations;
--
-- Expected distribution:
--   SELECT payment_status, COUNT(*) FROM registrations GROUP BY payment_status ORDER BY count DESC;
--   PENDING:   277 (242 no-action + 35 former WAIVED lab claims)
--   SPONSORED: 250 (fully sponsored via codes)
--   VERIFYING:  15 (bank transfer proof uploaded)
--   PARTIAL:    15 (partially sponsored, owe remainder)
--   PAID:       14 (confirmed bank transfers)
--   WAIVED:      1 (Sami Hmid - admin decision)
--   REFUNDED:    0
--
-- PaymentTransaction backfill:
--   SELECT COUNT(*) FROM payment_transaction;
--   Expected: 14 (one per confirmed bank payment)
--
-- paidCount spot check (top AMGLS workshops):
--   SELECT ea.name, ea.registered_count, ea.paid_count
--   FROM event_access ea JOIN events e ON ea.event_id = e.id
--   WHERE ea.registered_count > 0 ORDER BY ea.registered_count DESC LIMIT 10;
--   Vertiges:  registered=195, paid_count≈115
--   HTA:       registered=174, paid_count≈107
--
-- Zero amount_due for settled registrations:
--   SELECT COUNT(*) FROM registrations
--   WHERE payment_status IN ('PAID', 'SPONSORED', 'WAIVED')
--     AND (total_amount - paid_amount - sponsorship_amount) > 0;
--   Expected: 1 (Sami Hmid has 240 TND due but is WAIVED)

COMMIT;

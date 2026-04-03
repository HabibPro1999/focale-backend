# Dev → Prod Migration (2026-04-03)

## Overview

This migration brings the production database in sync with the dev schema and migrates payment status data to the new 7-status lifecycle.

## What changed

### Schema additions (handled by `prisma db push`)

| Change | Type | Risk |
|--------|------|------|
| `PaymentStatus` enum: add `PARTIAL`, `SPONSORED` | Additive | None — existing values untouched |
| `TransactionType` enum: new | Additive | None |
| `payment_transaction` table: new | Additive | None — empty table |
| `certificate_templates` table: new | Additive | None — empty table |
| `registrations.registration_role` column: new | Additive | Defaults to `PARTICIPANT` |
| `registrations.reference_number` column: new | Additive | Nullable |
| `registrations.dropped_access_ids` column: new | Additive | Defaults to `{}` |
| `registrations.edit_token_expiry` column: dropped | Destructive | Contains 7 non-null values (not used by any code) |

### Data migration (handled by `migration.sql`)

| What | Count | From → To | Why |
|------|-------|-----------|-----|
| Fully sponsored registrations | 250 | PAID → SPONSORED | These were marked PAID but paid_amount=0, sponsorship covers 100%. New SPONSORED status is more accurate. |
| Partially sponsored registrations | 15 | PENDING → PARTIAL | These have sponsorship linked but still owe 20-50 TND. New PARTIAL status distinguishes them from truly pending. |
| Unconfirmed lab claims (AMOMS) | 35 | WAIVED → PENDING | These doctors selected "Lab Sponsorship" as payment method but no actual sponsorship was linked. WAIVED was premature — admin needs to confirm with the lab first. |
| Sami Hmid anomaly | 1 | PAID → WAIVED | Manually marked PAID by admin with no payment or sponsorship. Treating as admin waiver. |
| PaymentTransaction backfill | 14 | (new rows) | Creates immutable ledger entries for all existing confirmed bank transfers. |
| Client modules | 3 | Add `certificates` | Enables the certificates module for all clients. |

## Production state before migration

### 581 registrations across 2 events

**AMGLS** (10ème Congrès Médecine Générale) — 514 registrations, 266 sponsorships
- 221 PENDING (no method, no action)
- 15 PENDING + LAB_SPONSORSHIP (partially sponsored, owe 20-50 TND each)
- 13 VERIFYING + BANK_TRANSFER (proof uploaded)
- 250 PAID + LAB_SPONSORSHIP (fully sponsored, sponsorship=total, paid=0)
- 14 PAID + BANK_TRANSFER (legit bank payments, paid=total)
- 1 PAID + no method (Sami Hmid anomaly)

**AMOMS** (9ème Congrès AMOMS) — 67 registrations, 0 sponsorships
- 21 PENDING (no method)
- 9 PENDING + CASH (selected cash, awaiting day-of-event payment)
- 2 VERIFYING + BANK_TRANSFER (proof uploaded)
- 35 WAIVED + LAB_SPONSORSHIP (lab claims, no actual sponsorship linked)

### Expected state after migration

| Status | Count | Description |
|--------|-------|-------------|
| PENDING | 277 | 242 no-action + 35 former WAIVED lab claims |
| SPONSORED | 250 | Fully covered by sponsorship codes |
| VERIFYING | 15 | Bank transfer proof uploaded |
| PARTIAL | 15 | Partially sponsored, owe 20-50 TND |
| PAID | 14 | Confirmed bank transfers (paid_amount = total_amount) |
| WAIVED | 1 | Sami Hmid (admin decision) |
| REFUNDED | 0 | None |
| **Total** | **581** | Must match pre-migration count |

## Deploy procedure

```bash
# 1. Swap to prod env
cd /Users/mohamed/projects/focale-os/backend
cp .env .env.dev
cp .env.prod .env

# 2. Push schema (adds enums, tables, columns)
bun x prisma db push --accept-data-loss
# The --accept-data-loss flag is needed because edit_token_expiry is being dropped.
# That column has 7 non-null values but is not used by any code.

# 3. Run data migration
PROD_URL=$(grep DATABASE_URL .env.prod | grep -v '^#' | cut -d'=' -f2-)
psql "$PROD_URL" -f scripts/devtoprod/migration.sql

# 4. Verify
psql "$PROD_URL" -c "SELECT payment_status, COUNT(*) FROM registrations GROUP BY payment_status ORDER BY count DESC;"
psql "$PROD_URL" -c "SELECT COUNT(*) FROM payment_transaction;"
psql "$PROD_URL" -c "SELECT COUNT(*) FROM registrations;"  # Must be 581

# 5. Restore dev env
cp .env.dev .env
rm .env.dev

# 6. Deploy backend, admin, form (in that order)
```

## Risks and mitigations

### WAIVED → PENDING (35 AMOMS records)
These doctors claimed lab sponsorship but no sponsorship code was ever linked. Their status changes from "settled" to "pending." The AMOMS admin may notice and ask why.

**Mitigation:** The `lab_name` field is preserved on all 35 records. The admin can see who claimed which lab. The correct workflow is: admin contacts the lab, confirms, then marks as PAID or links a sponsorship.

### Sami Hmid (PAID → WAIVED)
This is a judgment call. If he was supposed to be PAID, the admin can change him back.

**Mitigation:** Single record, easily reversible. Audit log will show the change.

### edit_token_expiry drop
7 registrations have non-null values. This column is not read by any code — it was replaced by the edit_token-based system.

**Mitigation:** No functional impact. Data loss is acceptable.

## Rollback

If something goes wrong, the status changes can be reversed:

```sql
-- Reverse SPONSORED → PAID
UPDATE registrations SET payment_status = 'PAID'
WHERE payment_status = 'SPONSORED';

-- Reverse PARTIAL → PENDING
UPDATE registrations SET payment_status = 'PENDING'
WHERE payment_status = 'PARTIAL';

-- Reverse PENDING (former WAIVED) → WAIVED (for AMOMS lab claims)
UPDATE registrations SET payment_status = 'WAIVED'
WHERE payment_status = 'PENDING'
  AND payment_method = 'LAB_SPONSORSHIP'
  AND sponsorship_amount = 0
  AND event_id = 'f2b6e862-5a62-46ab-a502-2a4beb5f18dd';

-- Reverse Sami Hmid
UPDATE registrations SET payment_status = 'PAID'
WHERE id = '62823c18-eb0f-43e2-8860-c653ece49c34';

-- Drop backfilled transactions
DELETE FROM payment_transaction WHERE note = 'Backfilled from legacy paidAmount';
```

Note: The new enum values (PARTIAL, SPONSORED) and tables (payment_transaction, certificate_templates) cannot be easily rolled back via SQL. They are additive and harmless if unused.

# Action Items — Backend Review Fixes

Uncommitted changes across **all seven modules**: identity + clients + auth, sponsorships, events + forms, pricing + access, registrations, email + certificates, checkin + reports.

**Final verification:** type-check clean (0 errors), test suite 684/684 passing, 0 lint regressions.

## DB Migrations

| Change | Module | Status |
|--------|--------|--------|
| `sponsorship_batches.idempotency_key` (nullable, unique) | sponsorships | Not applied — deploy per CLAUDE.md swap-env procedure |
| `registrations.edit_token_hash` (nullable, unique) + drop `edit_token` | registrations | Migration file generated at `prisma/migrations/20260417000000_harden_edit_token/`. **Option A rollout: all existing edit tokens invalidated** — registrants re-request via existing `/edit-token-request` endpoint. |
| `email_logs.idempotency_key` (nullable, unique) | email | Migration file generated at `prisma/migrations/20260417000001_add_email_log_idempotency_key/` |

All migrations are additive or replace one column with another. No data migration. No destructive changes beyond the intentional edit-token invalidation (Option A).

## Frontend — Required Before Deploy

### Sponsorships

| Change | Where | Status |
|--------|-------|--------|
| Widen sponsorship code input `maxLength` to ≥32 | Admin dashboard | ✅ Nothing to do — admin `RegistrationSponsorshipsSection` input has no `maxLength` restriction |
| Widen sponsorship code input `maxLength` to ≥32 | Public registration form | ⚠️ No dedicated code input in form app. If any existing form schema has a text field for sponsorship codes with `validation.maxLength ≤ 11`, update it via the form builder |
| Verify code rendering in print/PDF/email templates | Ops/design | ⬜ Manual check — 29-char codes may break fixed-width layouts |
| Decide module enable/disable UX | Admin — client edit | ✅ Nothing to do — enabled modules are locked (checkbox disabled) in `ClientFormSheet`, backend never receives a removal request |

### Events + Forms

| Change | Where | Status |
|--------|-------|--------|
| Banner upload size client-side guard | Admin — event banner upload | ✅ Done — widened client guard from 2 MB to 10 MB in `EventFormSheet.tsx`; matching copy in `events.json` (en+fr) |
| Slug case normalization | Admin — event create/edit | ✅ Done — slug input now lowercases on change in `EventFormSheet.tsx`, so preview and stored value match |
| Form builder — unknown top-level keys | Admin — form builder save path | ⚠️ Audit (data) — existing saved schemas with extra top-level keys (anything besides `steps`) will be rejected with 400 on re-save. Reads still work. Run one-off query to surface schemas with unknown keys: `SELECT id, schema FROM forms WHERE jsonb_object_keys(schema) NOT IN ('steps')` |
| Form builder — invalid schema feedback | Admin — form builder save path | ✅ Done — backend error code `FRM_9000` now mapped to user-friendly message in `errors.json` (en+fr); surfaces via existing `getErrorMessage` toast path |
| Capacity decrease error | Admin — event edit | ✅ Done — backend error code `EVT_8003` now mapped to user-friendly message in `errors.json` (en+fr); surfaces via existing `getErrorMessage` toast path |

### Pricing + Access

| Change | Where | Status |
|--------|-------|--------|
| Access capacity decrease error | Admin — access item edit | ✅ Nothing to do — same `EVT_8003` `CAPACITY_BELOW_REGISTERED` code reused from events+forms session; already mapped in `errors.json` en+fr. Surfaces via existing `getErrorMessage` path. |

### Registrations

| Change | Where | Status |
|--------|-------|--------|
| Edit token URL format | Existing edit links stop working after migration | ⚠️ **Option A rollout:** all existing in-flight edit-token emails become invalid on deploy. Registrants re-request via existing `/edit-token-request` endpoint (already wired). Communicate to support team. |
| Edit token expiry handling | Form app — edit page | ✅ Done — `STT_12003` mapped in form `lib/error-messages.ts` (FR) and admin `errors.json` (en+fr). Surfaces via existing `showErrorByCode` / `getErrorMessage` paths. |
| Admin payment-state force-override | Admin — registration edit | ✅ Done — `force` + `transitionReason` added to `AdminEditRegistrationInput` / `UpdateRegistrationInput`. `RegistrationFormDialog` renders a collapsible "Force transition" checkbox + reason textarea only in edit mode and only when the selected `paymentStatus` differs from the registration's original status. Reason validation enforces ≥10 chars client-side. Translations added (en+fr). |
| Registrant search PII | Admin — sponsorship linking UI | ✅ Nothing to do — `LinkSponsorshipDialog` in admin does not reference `phone` or `formData`, verified via grep. |

### Email + Certificates

| Change | Where | Status |
|--------|-------|--------|
| Certificate image upload dimensions | Admin — certificate template upload | ✅ Done — `CertificateTemplateEditor` reads image dimensions client-side and rejects >4000×3000 before upload, showing exact dimensions in the toast. `FIL_10002` mapping remains as fallback for any backend reject. |
| Bulk sponsor email partial success | Admin — bulk sponsor email action | ✅ Pre-wired — `BulkSendResult.skipped?: number` added to type, `BulkSendDialog` toast shows "N queued, M skipped" when field is present. ⚠️ Backend `email.routes.ts` still returns only `{ queued, message }`; will light up automatically once backend surfaces the `skipped` count that `queueBulkSponsorEmails` already computes internally. |

### Checkin

| Change | Where | Status |
|--------|-------|--------|
| Concurrent check-in duplicates | Scanner app / admin check-in | ✅ Server-side only — atomic now. Two simultaneous scans of the same ticket yield one check-in record + `alreadyCheckedIn: true` on the second call. No frontend change needed. |

## Frontend — Optional

| Change | Where | Status |
|--------|-------|--------|
| Send client-generated `idempotencyKey` on sponsor batch POST | Sponsor form | ✅ Done — `useSponsorshipSubmission.ts` now generates/reuses a sessionStorage key per slug, clears on success. `CreateSponsorshipBatchInput` type updated. |

## Behavior Changes (No Code Action, Communicate)

| Change | User-facing effect |
|--------|--------------------|
| Doctor emails (linked-account mode) no longer show sponsorship code | Recipients see beneficiary/lab info only. Code-mode emails unchanged. |
| Client delete 409 now lists all blocking tables | Admin sees clearer error detail |
| Event slug now stored lowercase | `Acme-2025` input → `acme-2025` stored. Existing mixed-case slugs unchanged until re-saved. |
| Concurrent event/form creation returns 409 (was 500) | Admin sees cleaner error on simultaneous creates |
| Invalid form schema rejected on save | Form builder save returns 400 on malformed steps/fields structure |
| Banner uploads >10 MB rejected | Admin sees 400 instead of silent upload |
| Payment-config endpoint rate-limited (20/min per IP) | Scraping resistance; legitimate users unaffected |
| Access `maxCapacity` decrease below `paidCount` rejected | Admin sees 400 `CAPACITY_BELOW_REGISTERED`; previously left system in invalid state |
| Audit log on access-drop now records `sponsorshipAmount` delta | Accounting can reconcile why a registration's amount-due shifted when an access item is deactivated or over capacity |
| Edit tokens now SHA-256 hashed, expire at event start | No more plaintext tokens in DB. Auto-extends if admin moves event date. |
| Admin edit payment-state machine enforced | `validatePaymentTransition` rejects invalid transitions (e.g. REFUNDED→PENDING) unless `force: true` + `transitionReason` provided |
| Registrant search response no longer includes phone / formData | PII leak closed. Sponsorship-linking UI sees only name + email + payment status. |
| `Registration.sponsorshipAmount` now derived from `SponsorshipUsage` sum | Prevents drift from admin edits. Admin can no longer manually set sponsorshipAmount. |
| Edit-token lifecycle now audited | Token generation + verification failures recorded in audit trail (hash prefix only) |
| Email duplicates prevented via `idempotencyKey` | `{registrationId}:{trigger}` unique constraint catches dedup race at DB level. |
| Email subject lines CRLF-sanitized | Registrant name with `\r\n` injection attempts rendered safe. |
| SendGrid webhook endpoint rate-limited | 100 req/min. Only affects flooding attempts with invalid signatures. |
| Certificate PDF generation bounded to 3 concurrent | Memory spike risk on bulk sends reduced. Invisible throughput ceiling. |
| Stuck email rows auto-recovered on worker boot | Rows >5min in `SENDING` automatically returned to `QUEUED` on next startup. |
| Access + event check-ins atomic | Concurrent scans of same ticket no longer leave counters inconsistent or throw 500. |
| Force-delete restricted to CLIENT_ADMIN | SUPER_ADMIN can no longer force-delete client registrations (matches docstring intent). |

## Silent / Internal — No Action

- Super admin delete race → serializable transaction
- Tenant isolation → lowercase UUID compare
- Sponsorship code entropy → 40→128 bits
- Removed `generateUniqueCode` retry loop (dead after entropy fix)
- `coveredAccessIds` capped at 50
- Event creation slug check moved inside transaction
- Form type existence check moved inside transaction
- Sponsor-form settings merge now re-validated against Zod
- `FormSchemaJsonSchema` switched `looseObject` → `strictObject`
- Event update merged-state date validation (was already present; plan overstated)
- Access cleanup loops: N+1 sponsorship-usage query replaced with single batched `findMany` (perf at scale)
- Shared helper `fetchCoveredAccessIdsByRegistration` used by `dropAccessFromUnsettledRegistrations` + `handleCapacityReached`

## Open Questions

- `LinkSponsorshipByCodeSchema.max` widened 10→32 silently. Decide: keep generous, or tighten to exact regex `/^SP-[0-9A-HJKMNP-TV-Z]{26}$/`
- Prod DB: any mixed-case event slugs today? If yes, decide: one-off backfill (`UPDATE events SET slug = LOWER(slug)`) or leave alone (reads stay exact-match until admin re-saves)
- Prod DB: any saved form schemas with extra top-level keys? If yes, they'll fail on re-save until cleaned up

## Deferred (Flagged, Not in This Batch)

- **Slug uniqueness per-client** — Batch B of events+forms plan. Breaking change: Prisma migration + path changes on every slug-based public route + frontend coordination across admin/form/sponsor. Schedule separately.
- Beneficiary PII encryption at rest (policy)
- CSV formula injection (no export yet)
- Admin rate limits on sponsorship link/unlink (insider risk)
- Sponsor email deliverability check (belongs with email module)
- Event status transition enum exhaustiveness check (low value)
- Form creation idempotency (admin-triggered, rare retry)
- Schema version migration framework (by-design snapshot)
- Stale pricing UX in sponsor form endpoint (recalc at submission is source of truth)
- Access soft-delete workflow — `active: false` field exists but unused; feature request, not a bug
- Access prerequisite DFS scope — edge-case false-positive on unrelated cycles; skipped, not a 5-line fix
- Price cascade to existing registrations — by-design grandfathering, not a bug
- Money rounding documentation — all prices are `.int()` end-to-end; no rounding path exists
- Public pricing endpoint `appliedRules` exposure — by-design registrant transparency

## Remaining Modules

All seven reviewed. Nothing outstanding.

## Known deferred for future work

- Excel OOM on very large events — `excel-generator.ts` loads all rows into memory. No event today has hit the scale where this matters. Revisit with ExcelJS streaming API when any event crosses ~5k registrants.
- Access prerequisite DFS scope narrowing (edge case, low impact)
- Non-Latin font support in certificate PDF rendering (regional request)
- `buildEmailContext` vestigial cast after edit-token type migration — cosmetic TS cleanup

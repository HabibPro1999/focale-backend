# Networking spaces and exhibitor representatives

## Model

- A **space** contains either ordinary tables or exhibitors. Its capacity is the maximum number of those items, from 1 to 500.
- Creating a table space creates the requested number of tables. Increasing capacity adds tables; decreasing capacity removes only tables without meeting history. Each table is always for two people and one simultaneous meeting.
- Adding an exhibitor consumes **one space slot**, irrespective of its number of representatives. The exhibitor name identifies the organization. Select one or more registered event participants as representatives.
- Each exhibitor meeting pairs one representative with one visitor. The organization's place is reserved for its representative. Three representatives can therefore receive three visitors simultaneously at one exhibitor, subject to each person's availability.
- A representative belongs to one exhibitor in the event. Reassignment/removal cannot invalidate an outstanding meeting. Existing mutual-connection, eligibility, consent, blocking and availability rules still apply.

## Implementation

`networking_spaces` is the parent inventory. Existing `networking_tables` rows remain the table/exhibitor records and reference `space_id`. `networking_profiles.stand_table_id` identifies all representatives of an exhibitor. The legacy single `owner_profile_id` is retained for compatibility; the organizer editor now submits `representativeIds`.

Bookings reserve both participants and either `table:<id>` or `stand:<id>:profile:<representativeId>` in five-minute intervals. All allocation and inventory changes share the event transaction lock. No whole-space reservation is created. Failed rescheduling leaves the old booking intact; cancelling one representative's meeting does not release another representative's reservation.

Table creation uses a batch insert. Allocation precomputes resource occupancy and table usage instead of repeatedly scanning all reservations/meetings for each candidate. Public representative lists reuse the SQL discovery filters for event, consent, payment, visibility, duplicate email and symmetric blocking.

The organizer's Spaces tab manages space capacity and contents. Calendar cells show the remaining unreserved meeting places at an exhibitor; these are not a promise of participant availability. Occupancy counts representative time independently. Participant profiles link to eligible colleagues at the same exhibitor, with each person's own availability and connection actions.

## Deployment and migration

Apply **`0018_networking_spaces.sql` before deploying the new API**, then deploy matching admin/PWA builds. The existing checked networking migration runner discovers it automatically:

```sh
# Inspect only.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs
# Apply using the explicitly selected deployment DATABASE_URL.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs --apply
```

Legacy table/exhibitor and meeting IDs are preserved. Each existing inventory record is placed in its own one-slot space. **Old seating capacity is not reinterpreted as a table count.** Review existing space names/capacities after migration and set the intended number of tables/exhibitors in admin.

Legacy capacity values normalize to two; a database constraint prevents other seating counts. Existing known stand representatives are linked to their exhibitor, and identified whole-stand reservation keys become per-representative keys. A legacy booking whose representative cannot be identified retains its conservative whole-stand lock until it is completed/cancelled/reassigned. Profile/event ownership is still checked by the API.

No production database was migrated or application deployed for this change. Migration verification below used PostgreSQL with pgvector; it is not a claim of a CockroachDB deployment test.

## Verification — 2026-09-15

| Check | Result |
| --- | --- |
| Backend workspace typecheck / ordinary tests / build | PASS; 1,320 tests passed, 52 environment-gated tests skipped. |
| Focused real database tests | PASS; 11 new inventory cases, 18 existing networking domain cases and 5 analytics cases. Covers simultaneous tables, multiple representatives in one exhibitor, representative double-booking, capacity/type/ownership checks, removal guards, cancellation isolation, failed reschedule preservation and roster privacy. |
| Legacy migration tests | PASS; three checks for capacity interpretation, preserved booking/representative/resource identities, database seat constraint and event cascade cleanup. |
| Admin tests / lint / production build | PASS; 154 tests, including new capacity/representative/calendar UI coverage. |
| Admin standalone TypeScript check | Same 29 existing errors outside networking; no errors in changed networking files. |
| Participant tests / typecheck / production build | PASS; 45 tests, including selecting and connecting to a different available representative. |
| Local organizer browser | PASS; Firebase emulator login, create Salle Oya QA with capacity 3 → three two-person tables; create Exhibitor Hall QA with capacity 2 → one organization with three selected representatives consumes one slot. |
| Local participant browser | PASS; synthetic visitor opens the exhibitor roster, selects another representative and sees that person's own available times. Browser screenshots captured in the task. |

Local browser checks used an isolated test database and Auth emulator with synthetic participants. The networking email/push worker was not started, and no external messages were sent. Broader device/provider cases in the full QA suite remain unexecuted.

Relevant tests: `apps/api/src/modules/networking/networking.inventory.db.test.ts`, `packages/db/tests/migration/networking-spaces.migration.test.ts`, `admin/src/features/networking/components/InventoryEditors.test.tsx` and `networking/src/test/exhibitor-representatives.test.tsx` (last two paths are relative to the shared workspace).

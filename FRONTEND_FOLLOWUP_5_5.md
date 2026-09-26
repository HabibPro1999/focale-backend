# Frontend follow-up: 5.5 response contracts

No response field was removed, renamed or retyped. The covered routes (list in
README-rebuild.md, "Response contracts") now return only the fields their
contract declares, and each contract lists every field those routes returned
before this change, so today's payloads are unchanged byte for byte. What
changes is the default for the future: a column added to a table, or a field
added to a service result, is no longer returned by these routes until the
backend adds it to the contract.

Checked against admin `develop` 50e99c7 and form `develop` ba6c271 (read only):
the fields they read from these responses are all in the contracts, including
the admin grid's `mergeWith` column metadata, `accessCheckIns`,
`coveredAccessItems`, and the form app's use of the access rows' capacity
fields (`maxCapacity`, `registeredCount`, `paidCount`), `companionPrice`,
`requiredAccess`, `spotsRemaining`/`isFull`, bank details and
`successTranslations`.

## Both repos

- The generated artifacts (`packages/contracts/generated/`, see 5.6) now
  include the response shapes. Use the output-side types for what these routes
  return, for example `PublicRegistrationForEditResponse`,
  `PublicFormResponse`, `GroupedAccessResponse`, `AdminRegistrationResponse`,
  `SponsorshipDetailResponse`. Dates are ISO 8601 strings on the wire.
- `TimeSlot.items` (grouped access) is now typed as `GroupedAccessItem[]`; it
  was `unknown[]`. The data did not change.
- Fields holding stored JSON stay `unknown` in the types: `formData`,
  `priceBreakdown`, form `schema`, `successTranslations`, pricing `rules`,
  access `conditions`, audit-log `changes`.
- Outside production, a covered route whose data does not match its contract
  fails with 500 `SRV_5001` (the message names the fields). This is a backend
  bug signal for dev and CI; production returns the projected data instead.

## Candidates for a later tightening (not changed here)

These are returned today only because the routes used to return whole rows.
Removing any of them would be a breaking change, so each needs a frontend check
first:

- `GET /api/forms/public/:slug`: `event.clientId` (the form app does not read
  it), `event.createdAt`/`updatedAt`, the pricing row's `id`/`eventId`/
  timestamps, and the access rows' `eventId`/timestamps.
- `POST /api/public/registrations/:id/payment-proof`: `fileUrl`, the stored
  proof location (the form app's `src/types/registration.ts` declares it; 0.5
  left it open).

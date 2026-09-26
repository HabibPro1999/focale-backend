# Frontend follow-up: 5.5 response contracts

One response field was removed (see "Removed field" below); none was renamed
or retyped. The covered routes (list in README-rebuild.md, "Response
contracts") now return only the fields their contract declares. Apart from
that one field, each contract lists every field those routes returned before
this change, so the other payloads are unchanged byte for byte. What changes
is the default for the future: a column added to a table, or a field added to
a service result, is no longer returned by these routes until the backend adds
it to the contract.

## Removed field

- `GET /api/forms/public/:slug` no longer returns `event.clientId`. The
  organizer is still in `event.client` (`id`, `name`, `logo`, `primaryColor`,
  `phone`). The form app has no `clientId` reference at all (`develop` =
  `origin/develop` ba6c271 and `main`, read-only check); admin `develop`
  50e99c7 does not call this route. The generated
  `PublicFormResponse` type drops the field.

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
- The generated `RegistrantSearchResult` type now matches what both
  registrant-search routes return: no `phone` or `formData` (5.7 removed them
  from the admin route as well; the anonymous sponsor-form route never returned
  them), `accessAmount` added, `paymentStatus` a string. The admin app has no
  caller of the admin search route; the form app's sponsor search is unchanged.
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

- `GET /api/forms/public/:slug`: `event.createdAt`/`updatedAt`, the pricing
  row's `id`/`eventId`/timestamps, and the access rows' `eventId`/timestamps.

Kept on purpose: `POST /api/public/registrations/:id/payment-proof` still
returns `fileUrl`, the stored proof location (the form app's
`src/types/registration.ts` declares it; 0.5 left it open).

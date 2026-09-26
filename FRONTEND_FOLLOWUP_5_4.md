# Frontend follow-up: 5.4 tenant scoping and unified error codes

Checked against admin `develop` 50e99c7, form `develop` ba6c271 (= `origin/develop`)
and networking `HEAD` 1d8d454, read only.

## Error codes: old → new

| Condition | Where | Before | After |
|---|---|---|---|
| Client (tenant) inactive | Every module-gated route, admin and public (below); the auth check for a client admin whose client is inactive | 403 `AUTH_1004` "Client is inactive" | 403 `CLT_20001` (`CLIENT_INACTIVE`), same message |
| Module disabled for the client | Every module-gated route, admin and public (below) | 403 `AUTH_1004` "`<Module>` module is disabled for this client" (public price quote: "Pricing module is disabled") | 403 `CLT_20002` (`MODULE_DISABLED`), same messages |
| Registration not found | Admin registration routes: `GET`/`PATCH`/`DELETE /api/events/registrations/:id`, `…/confirm`, `…/audit-logs`, `…/email-logs`, `…/payment-proof`, `GET /api/registrations/:id/edit-link`, `/api/registrations/:registrationId/available-sponsorships`, `…/sponsorships` (GET, POST, `by-code`, DELETE) | 404 `RES_3001` | 404 `REG_8001` (`REGISTRATION_NOT_FOUND`) |
| Registration not found at check-in | `POST /api/events/:eventId/checkin` | 404 `CHK_17002` | 404 `REG_8001`; `CHK_17002` is retired |
| Registration not found for the event | `POST /api/events/:eventId/registrations/:registrationId/send-custom-email` | 404 `RES_3001` | 404 `REG_8001` |
| Access item not found | `GET`/`PATCH`/`DELETE /api/events/access/:id`, `GET /api/public/events/:eventId/access/:accessId`, `GET /api/events/:eventId/checkin/registrations?accessId=`, `GET /api/events/:eventId/analytics/access-items/:accessId/registrations` | 404 `RES_3001` | 404 `ACC_7001` (`ACCESS_NOT_FOUND`) |
| Event pricing not found | `GET /api/events/:eventId/pricing` | 404 `RES_3001` | 404 `PRC_6005` (`PRICING_NOT_FOUND`) |

Unchanged: event, sponsorship and email template not found stay 404
`RES_3001`; another client's resource stays 403 `AUTH_1004`; an archived event
on a write stays 400 `STT_12001`.

Module-gated routes that now answer `CLT_20001`/`CLT_20002`: the admin
abstracts, email, pricing, registration writes, sponsorship writes, access,
certificates, forms and networking admin routes; the sponsorships export (new,
below); and the public signup, self-edit, payment-proof upload, access,
sponsor-form, abstract submission and price-quote routes.

## Other changes a client can see

- `GET /api/events/:eventId/reports/sponsorships` now needs the sponsorships
  module: 403 `CLT_20002` when it is disabled (`CLT_20001` when the client is
  inactive). It had no module check.
- On the 76 routes now scoped by a guard (list in README-rebuild.md, "Tenant
  scoping"), the tenant check runs before body and query validation: another
  client's request with an invalid body gets 403, not 400. A malformed id in
  the path is still 400 `VAL_2001`.
- Pricing admin routes: the 403 message is now "Insufficient permissions"
  (it was route-specific, e.g. "Insufficient permissions to update this
  event"); the code is still `AUTH_1004`.
- Email template routes: the caller must reach both the template's client and
  its event's client (each route checked one of them). The write routes
  (`PATCH`/`DELETE /api/events/email-templates/:templateId`, `…/duplicate`,
  `…/test-send`) answer 403 for another client's template before anything
  else; before, a template without an event answered 400 "Email template is
  not event-scoped" to anyone. Your own client's template without an event is
  still 400.
- `POST /api/events/email-templates/:templateId/duplicate` validates its body:
  optional, `{ name?: string }` with 1–255 characters and no other keys
  (400 `VAL_2001`). An empty `name` is now 400 (it used to fall back to
  "<name> (Copy)"). The admin app sends no body: unchanged.

## Admin app

- **Before this reaches production** (French screens are being filmed): add
  `CLT_20001` and `CLT_20002` to `src/i18n/locales/{fr,en}/errors.json`.
  `getErrorMessage` maps `AUTH_1004` today; without entries for the new codes
  it falls back to the backend's English message ("Pricing module is disabled
  for this client"). Suggested fr: `CLT_20001` "Ce client est désactivé.",
  `CLT_20002` "Ce module n'est pas activé pour ce client."
- `REG_8001`, `ACC_7001` and `PRC_6005` already have entries, so those
  refusals now show their specific message instead of "Élément introuvable."
- No code reads `CHK_17002`.

## Form app

- `src/api/errorCodes.ts` (`WIRE_TO_SEMANTIC_CODE`): add
  `CLT_20001: "CLIENT_INACTIVE"` and `CLT_20002: "MODULE_DISABLED"`; drop
  `CHK_17002`. No page compares against `FORBIDDEN`, so nothing breaks today;
  the public signup, self-edit, payment-proof, sponsor and price-quote routes
  send the new codes.

## Networking app

No change: its routes are not converted, and the participant-side gates keep
their `NETWORKING_*` codes.

## Generated artifacts

`DuplicateEmailTemplate` (input) is new in `packages/contracts/generated/`.
`ErrorCodes` is not part of the generated artifacts; the table above is the
list.

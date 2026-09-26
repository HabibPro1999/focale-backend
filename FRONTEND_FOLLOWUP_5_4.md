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
| Registration not found (5.4b) | `PATCH /api/public/registrations/:registrationId/payment-method` (any missing registration); `POST /api/public/registrations/:registrationId/payment-proof` when the registration is deleted during the upload | 404 `RES_3001` | 404 `REG_8001` |
| Registration of another event (5.4b) | `PUT /api/events/:eventId/registrations/:id/admin-edit`; `GET /api/registrations/:registrationId/available-sponsorships` (service check; the route reads the event from the registration) | 400 `RES_3003` | 400 `CHK_17004` (`CHECKIN_EVENT_MISMATCH`), same message "Registration does not belong to this event"; check-in already answered it |
| User not associated with any client (5.4b) | `GET /api/clients/me` (any user without a client, super admins included) | 404 `RES_3001` | 403 `AUTH_1004`, same message |
| User not associated with any client (5.4b) | `GET /api/events`, `GET /api/forms` (client admin without a client) | 400 `VAL_2001` | 403 `AUTH_1004`, same message |

Unchanged: event, sponsorship and email template not found stay 404
`RES_3001`; another client's resource stays 403 `AUTH_1004`; an archived event
on a write stays 400 `STT_12001`. 5.4b keeps form, certificate template and
client not found at 404 `RES_3001` and access item not found at 404 `ACC_7001`.

Why `CHK_17004` for "registration of another event": it is the one code
specific to that condition (`RES_3003` is the generic 400 many unrelated
refusals share, so a client cannot key on it), and check-in, where it happens
in practice (a badge from another event), already sends it. The two other
sites are reachable only with an event id and a registration id that do not
match.

Why 403 for "user not associated with any client": the request is valid and
the caller is authenticated but has no tenant, so it may not act on any
client. Every tenant-scoped route already answers such a user 403
"Insufficient permissions"; 400 (the request is malformed) and 404 (on a list)
said something else.

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
- 5.4b: 25 more routes are scoped by a guard: access items (5), certificates
  (8), `GET`/`PATCH`/`DELETE /api/events/:id` and `POST /api/events/:id/banner`,
  forms by id (5) and `GET`/`POST /api/forms/events/:id/sponsor`, and
  `GET /api/clients/:id`. As above, the tenant check now runs before body and
  query validation on them. `POST /api/events`, `POST /api/forms` and
  `GET /api/forms?eventId=` check the client or event named in the body or
  query with the same rules, after validation (a malformed body is still 400
  first).
- 5.4b: the 403 message is now "Insufficient permissions" on those routes (code
  still `AUTH_1004`). It was route-specific: "Insufficient permissions to
  access/update/delete this event", "… to create event for this client",
  "… to create form for this event", "… to access this event" (forms),
  "… to access/update/delete this form", "… to access this client".
- 5.4b, refusal order (404 before 403, as everywhere else):
  `GET /api/clients/:id` for a client that does not exist is 404 "Client not
  found" for everyone (a client admin got 403); `POST /api/events` with an
  unknown `clientId` is 404 "Client not found" for a client admin too (was 403;
  a super admin already got this 404).
- 5.4b: `GET /api/forms/:id/sponsorship-mode-locked` on a registration form now
  needs the registrations module, like the other routes on that form (it had
  no gate; a sponsor form still needs sponsorships). The answer for a
  registration form is still `{ locked: false }`.
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
- 5.4b: no screen reads the changed codes or messages. `clients/me` is fetched
  only for a client admin with a client, and errors are caught. Optional:
  `CHK_17004` has no entry in `errors.json` (the English message shows, at
  check-in too); suggested fr: "Cette inscription appartient à un autre
  événement."

## Form app

- 5.4b: `PATCH …/payment-method` on a missing registration now sends
  `REG_8001`, which `WIRE_TO_SEMANTIC_CODE` already maps to
  `REGISTRATION_NOT_FOUND` ("Inscription introuvable." instead of the generic
  not-found message). No change needed.
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

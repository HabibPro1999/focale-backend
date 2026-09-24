# Frontend follow-up: PII in responses (0.5)

## Admin

- `editToken` and `idempotencyKey` are no longer returned by any admin
  registration response: list (`GET /api/events/:eventId/registrations`),
  detail (`GET /api/events/registrations/:id`), admin create
  (`POST /api/events/:eventId/admin/registrations`), partial update
  (`PATCH /api/events/registrations/:id`), admin edit
  (`PUT /api/events/:eventId/registrations/:id/admin-edit`) and confirm payment
  (`POST /api/events/registrations/:id/confirm`). The admin app reads neither
  field today, so no code change is required.
- New `GET /api/registrations/:id/edit-link` → `{ ok: true, data: { url } }`,
  the registrant's self-edit link (the same URL the registration emails
  carry). It uses the same auth and tenant scoping as the detail route: 404
  `RES_3001` for an unknown id, 403 `AUTH_1004` for another tenant's
  registration, and 404 `RES_3001` ("This registration has no self-edit
  link") for admin-created registrations, which never get an edit token. The
  response is sent with `Cache-Control: no-store`, and every call writes an
  audit entry. Fetch it only on an explicit user action (never prefetch it in
  lists), and don't cache or log the URL.
- Registration audit log (`GET /api/events/registrations/:id/audit-logs`): new
  action `EDIT_LINK_ISSUED` (actor and IP, `changes: null`). Add it to the
  `AuditAction` type, `actionVariants` and `actionKeyMap` in
  `RegistrationUpdatesTab.tsx`, and add the `updatesTab.actions.EDIT_LINK_ISSUED`
  i18n key (en/fr). Until then the tab shows the raw action name.
- Admin registrant search (`GET /api/events/:eventId/registrants/search`)
  now matches `%`, `_` and `\` literally instead of treating them as
  wildcards. Its minimum length is unchanged (1 character).
- Non-production 500 responses no longer echo SQL or bound parameters in
  `error.message` (they now read `Failed query (SQL text and parameters redacted)`).
  Production responses are unchanged.

## Public form

- Registration create (`POST /api/public/forms/:formId/register`), self-edit
  (`PATCH /api/public/registrations/:id`) and GET-for-edit
  (`GET /api/public/registrations/:id`) return `registration` as an explicit
  allowlist of fields.
  - Removed: `editToken`, `idempotencyKey`, `linkBaseUrl`, `note`, `role`,
    `checkedInAt`, `checkedInBy`, `accessCheckIns`, `paymentReference`,
    `formSchemaVersion`, `accessTypeIds`, `droppedAccessIds`, `event.clientId`.
  - `paymentProofUrl` is replaced by `hasPaymentProof: boolean`.
  - Create still returns the registrant's own edit token as `registration.token`.
    Self-edit and GET-for-edit don't return a token.
  - Kept: `id`, `formId`, `eventId`, `referenceNumber`, `email`, `firstName`,
    `lastName`, `phone`, `formData`, `networkingOptIn`, `paymentStatus`,
    `paymentMethod`, `labName`, `currency`, `totalAmount`, `paidAmount`,
    `baseAmount`, `discountAmount`, `accessAmount`, `sponsorshipCode`,
    `sponsorshipAmount`, `priceBreakdown`, `accessSelections`,
    `droppedAccessSelections` (create/edit), `paidAt`, `submittedAt`,
    `lastEditedAt`, `createdAt`, `updatedAt`, `form` (`id`, `name`, plus
    `schema` on GET-for-edit) and `event` (`id`, `name`, `slug`, plus `status`
    and `endDate` on GET-for-edit).
  - The form reads none of the removed fields, so no code change is required.
    Optionally add `hasPaymentProof` to the `Registration` type.

## Sponsor form (linked-account mode)

- Registrant search (`GET /api/public/events/slug/:slug/registrants/search`):
  `query` must have at least 3 characters after trimming, otherwise the API
  returns 400 `VAL_2001`. `useRegistrantSearch` defaults `minQueryLength` to 2;
  raise it to 3 so 2-character input doesn't trigger error responses.
- `email` in each result is now masked (`alice@example.com` →
  `a***@example.com`). Phone and form data were already stripped. `%`, `_` and
  `\` in the query match literally.
- `DynamicBeneficiaryCard` copies `registrant.email` into the beneficiary email
  field, so that field now receives the masked value. Linked submissions send
  only `registrationId` and coverage, so the server is unaffected, but show the
  email as read-only (or don't prefill it) so nobody edits or relies on the
  masked value.

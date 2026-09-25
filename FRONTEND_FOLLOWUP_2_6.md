# Frontend follow-up — 2.6 settlement writer and registration locks

Contract changes for the admin and public form repos. 2.6b (payment status
writers under the registration lock) is below; 2.6c (repricing and edit
policy) appends its own section.

## 2.6b — payment confirmation and status changes (admin)

| Endpoint | Trigger | Before | After |
|---|---|---|---|
| `POST /api/events/registrations/:id/confirm` | `paymentStatus: "PAID"` with a `paidAmount` below the amount due | 200, stored PAID with money still owed | 400 `REG_8013` (`PAID_AMOUNT_BELOW_DUE`), `details: { amountDue, paidAmount }` |
| `POST /api/events/registrations/:id/confirm`, `PATCH /api/events/registrations/:id` | `VERIFYING` → `PARTIAL` | 400 `STT_12002` (`INVALID_PAYMENT_TRANSITION`) | allowed |
| `PUT /api/events/:eventId/registrations/:id/admin-edit` | changing the `paymentStatus` of a `REFUNDED` registration | allowed | 400 `STT_12002` (`INVALID_PAYMENT_TRANSITION`) |

- **Confirm dialog:** when an admin records less than the amount due, send
  `PARTIAL` with the amount. On `REG_8013`, offer to switch to PARTIAL and use
  `details.amountDue` as the amount for a full confirmation.
- **The amount due** is now computed from the sponsorships linked to the
  registration at the moment of confirmation. It can differ from a value
  cached in the page when a sponsorship changed meanwhile. Show the server's
  `details.amountDue`, not the cached one.
- **Admin edit:** hide or disable the status selector for a REFUNDED
  registration. A refund is final; every other admin status correction is
  still allowed.
- Concurrent admin actions on one registration (confirm, edit, partial
  update) now run one after the other. The later one sees the earlier result
  and is validated against it, so it can fail with a 4xx that depends on the
  earlier change, for example confirming a registration another admin just
  refunded. Refresh the registration on any 4xx from these endpoints.

## 2.6b — payment proof and payment method (public form)

| Endpoint | Trigger | Before | After |
|---|---|---|---|
| `POST /api/public/registrations/:id/payment-proof` | an admin confirmed the payment while the upload was in flight | 200, and the registration went back to `VERIFYING` | 400 `STT_12002` (`INVALID_PAYMENT_TRANSITION`); the registration stays confirmed and the uploaded file is discarded |
| `PATCH /api/public/registrations/:id/payment-method` | an admin confirmed the payment (or a proof moved it to `VERIFYING`) meanwhile | 200, and the registration went back to `PENDING` | 400 `REG_8004` (`REGISTRATION_INVALID_STATUS`) |

On either error, reload the registration and show its current payment state
instead of a generic failure.

## 2.6c — repricing and edit policy

| Endpoint | Trigger | Before | After |
|---|---|---|---|
| `PATCH /api/public/registrations/:registrationId` | a `PAID` registration's edit would change what it costs (added a paid item, an answer that changes the price) | 200, stayed `PAID` with money owed | 409 `REG_8014` (`REGISTRATION_PRICE_LOCKED`), `details: { currentNet, newNet }`; nothing is saved |
| `PATCH /api/public/registrations/:registrationId` | an edit that changes no answer and no access quantity (name, phone, or the same values sent again) | repriced at the event's current prices | the price and payment status are kept; the response's `priceBreakdown` is the stored one |
| `GET /api/public/registrations/:registrationId` | on the event's last day, when the end date has no time (midnight UTC) | `canEdit: false`, "Event is not accepting changes" | `canEdit: true`, as the edit itself already allowed |
| `PUT /api/events/:eventId/registrations/:id/admin-edit` | `formData` or `accessSelections` change a `PAID` registration's net, with neither `paidAmount` nor `paymentStatus` | 200, stayed `PAID` with money owed or overpaid | 409 `REG_8015` (`PAYMENT_ADJUSTMENT_REQUIRED`), `details: { currentNet, newNet, paidAmount }`; nothing is saved |
| `PUT /api/events/:eventId/registrations/:id/admin-edit` | the same, with a `paidAmount` below the new net and the status left `PAID` (or set to `PAID`) | 200 | 400 `REG_8013` (`PAID_AMOUNT_BELOW_DUE`), `details: { amountDue, paidAmount }` |
| `PUT /api/events/:eventId/registrations/:id/admin-edit` | a price edit with a `paidAmount` above the old net but within the new one | 400 `RES_3003` | allowed: the amount is checked against the new net |
| `PUT /api/events/:eventId/registrations/:id/admin-edit` | `accessSelections` that keep an item which is at capacity | 409 `ACC_7002` (`ACCESS_CAPACITY_EXCEEDED`) | allowed: only added quantities are checked against capacity |
| `PATCH /api/events/registrations/:id` | empty body `{}` | 500 | 200 with the current registration; nothing written, no audit entry |

- **Repricing never applies the registration's own sponsorship code.** The
  sponsorship of an edited registration is the one linked to it (sponsorship
  usages). A code typed at signup that was never linked keeps the amount it
  had at signup (capped at the new price); it is no longer priced again, so
  an unused code can't be taken off twice.
- **Self-edit form (public):** before sending an edit of a `PAID`
  registration, compare the quote with the current total. On `REG_8014`,
  explain that the registration is paid and that price changes go through
  the organizer, and restore the previous selection.
- **Admin edit dialog:** when an edit of a `PAID` registration changes the
  total, ask how the payment follows: the new amount collected (send
  `paidAmount`, it must equal the new net to stay `PAID`), or a new status
  (e.g. `PARTIAL` to leave the difference owed). On `REG_8015`, show
  `details.currentNet` and `details.newNet` and ask the same question.
- `eventAccess.countsChanged` after an admin or self edit now lists the
  access items whose counts moved (added, removed, or paid places; the admin
  edit used to send an empty list), and is no longer sent when nothing moved.

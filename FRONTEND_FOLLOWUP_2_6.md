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

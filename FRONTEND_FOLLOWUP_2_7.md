# Frontend follow-up — 2.7 sponsorship code consumed at signup

Contract changes for the public form repo (and what the admin sees). A
sponsorship code entered at signup is now single use: the signup links the
sponsorship to the new registration and marks it used, in the same
transaction.

## Public signup (`POST /api/public/forms/:formId/register`)

| Trigger | Before | After |
|---|---|---|
| `sponsorshipCode` unknown for the event, or its sponsorship was cancelled | 201; the code was stored and ignored (no reduction) | 400 `PRC_6004` (`INVALID_SPONSORSHIP_CODE`), `details: { sponsorshipCode }`; nothing is created |
| `sponsorshipCode` already used, reserved for another registration (linked lab batch), or already entered by an earlier registration | 201: a code only entered by earlier signups, or reserved for another registration, was applied again; a code an admin had linked gave no reduction | 409 `SPO_14003` (`SPONSORSHIP_CODE_ALREADY_USED`), `details: { sponsorshipCode }`; nothing is created |
| a valid code covering the whole price | 201, `paymentStatus: "PENDING"` | 201, `paymentStatus: "SPONSORED"` (nothing to pay) |
| a valid code covering part of the price | 201, `paymentStatus: "PENDING"` | 201, `paymentStatus: "PARTIAL"`; the rest to pay is `totalAmount − sponsorshipAmount − paidAmount` |
| blank code (`"   "`) | stored as typed | treated as no code |

- The code is matched trimmed and upper-cased; the stored
  `registration.sponsorshipCode` is the normalized code.
- The 201 body's `priceBreakdown` is now the stored, settled breakdown:
  `sponsorships: [{ code, amount, valid: true }]`, `sponsorshipTotal` and
  `total` reflect the linked sponsorship. Show these values, not the ones from
  the earlier quote.
- **Form:** on `PRC_6004` or `SPO_14003`, keep the answers, highlight the
  sponsorship-code field with a clear message ("This code is not valid for this
  event" / "This code has already been used") and let the registrant remove or
  change the code and submit again. A retry with the same idempotency key and
  the same code gets the same error (nothing was created).
- **After signup:** a `SPONSORED` registration needs no payment step; skip
  payment-method selection and proof upload. A `PARTIAL` one (code covering
  part of the price) currently cannot select a payment method or upload a
  proof (those require `PENDING`); see the open question in the PR before
  building a "pay the rest" step.

## Price quote (`POST /api/public/forms/:formId/calculate-price`)

- A code reserved for one registration by a linked lab batch is now quoted as
  `valid: false` (amount 0), like an unknown code. The quote is still only an
  estimate: signup decides again when it consumes the code.

## Admin

- A signup with a code now shows the sponsorship as linked (usage, status
  `USED`) with a `LINK_TO_REGISTRATION` history entry by `PUBLIC`, and a
  `sponsorship.linked` realtime event arrives with the `registration.created`
  one.
- After the operator runs the `repair-sponsorship-code-usages` script (not
  before plan 2.8 is deployed), repaired registrations show a new history
  action `DATA_REPAIR_SPONSORSHIP_LINK` and their sponsorship a
  `LINK_TO_REGISTRATION` entry, both by `SYSTEM:repair-sponsorship-code-usages`.
  Give the new action a label in the registration history view.

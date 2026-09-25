# Frontend follow-up — 2.8 sponsorships on the shared settlement code

Contract changes for the admin repo (and the public sponsor form). Admin
sponsorship link, unlink, cancel, delete, coverage edits and the linked-mode
lab batch now lock the sponsorship and its registrations and settle each
registration through the same code as payments, so a registration's status,
amounts and paid places always agree. Two new error codes.

## New errors

| Code | HTTP | When | `details` |
|---|---|---|---|
| `SPO_14004` `SPONSORSHIP_TARGET_SETTLED` | 409 | Linking a sponsorship to a `PAID`, `WAIVED` or `REFUNDED` registration. Unlinking, cancelling, deleting or changing the coverage of a sponsorship when that would change the sponsorship amount of a linked `PAID` registration. | `{ registrationId, paymentStatus }` |
| `SPO_14005` `SPONSORSHIP_EXCEEDS_AMOUNT_DUE` | 409 | Linking (or widening the coverage of) a sponsorship would leave the registration paid more than it then owes (`paidAmount > totalAmount − sponsorshipAmount`). | `{ registrationId, paidAmount, amountDue }` |

Endpoints that can return them:

- `POST /api/registrations/:registrationId/sponsorships` and
  `POST /api/registrations/:registrationId/sponsorships/by-code` (link):
  `SPO_14004`, `SPO_14005`.
- `DELETE /api/registrations/:registrationId/sponsorships/:sponsorshipId`
  (unlink): `SPO_14004`.
- `PATCH /api/sponsorships/:id` (coverage change, or `status: "CANCELLED"`)
  and `DELETE /api/sponsorships/:id`: `SPO_14004` (`SPO_14005` for a coverage
  change). Nothing is changed when one linked registration refuses: the whole
  request is rolled back; `details.registrationId` names the registration.

**Admin UI:** show the message with the registration; for `SPO_14004` on a
`PAID` registration the admin first changes its payment (e.g. to `PARTIAL`
through the payment edit), then retries. For `SPO_14005`, the admin first
records the refund of the excess (lower `paidAmount`), then retries.

## Behaviour changes (no new codes)

- **Status after link/unlink** follows the settlement rules everywhere:
  fully covered → `SPONSORED`; partly covered → `PARTIAL`; nothing covered
  and nothing paid → `PENDING`. `VERIFYING` keeps its status (only the amounts
  move). A `REFUNDED` registration is never revived (before, a batch or link
  could turn it `SPONSORED`).
- **Unlinking the last sponsorship** sets the sponsorship amount to 0 (an old
  signup amount without a link is no longer kept), clears
  `registration.sponsorshipCode` when it is the unlinked sponsorship's code
  (that code is then usable again at signup), drops that code's line from
  `priceBreakdown.sponsorships`, and clears `paymentMethod` only when it is
  `LAB_SPONSORSHIP` (before: any method was cleared).
- **Coverage edit** (`PATCH /api/sponsorships/:id` with `coversBasePrice` or
  `coveredAccessIds`) re-settles every linked registration: status and paid
  places now follow the new amount (before, only the amounts moved).
- **Link by code** matches the code trimmed and upper-cased.
- **Linked-mode lab batch with auto-approve** (public sponsor form): a
  beneficiary registration that is `PAID`, `WAIVED` or `REFUNDED`, already
  paid more than it would owe, or holds nothing the sponsorship covers, gets
  a `PENDING` sponsorship targeted at it instead of a linked one (before: the
  link was forced). The batch still succeeds; the admin links or cancels it
  later. Such a sponsorship gets no `SPONSORSHIP_LINKED` email.

## Realtime and history (restored)

- Link: `sponsorship.linked`, `registration.updated` (or
  `registration.paymentConfirmed` when it became `SPONSORED`),
  `eventAccess.countsChanged` with the moved `accessIds`.
- Unlink: `sponsorship.unlinked`, `registration.updated`,
  `eventAccess.countsChanged`.
- Cancel / delete: `sponsorship.cancelled` / `sponsorship.deleted`, plus
  `registration.updated` per unlinked registration and one
  `eventAccess.countsChanged` when any was linked.
- Coverage or beneficiary edit: `sponsorship.updated` (+ registration events
  when registrations were re-settled).
- Lab batch: `sponsorship.batchCreated` (`payload: { id, batchId, count }`),
  and per auto-linked registration `sponsorship.linked` + registration events.
- Sponsorship history entries are written again: `UPDATE`, `CANCEL`,
  `DELETE`, `LINK_TO_REGISTRATION` (admin, or `SYSTEM` for auto-approved
  batches), `UNLINK_FROM_REGISTRATION` (its `changes` may now also list
  `paymentStatus`, `paymentMethod`, `sponsorshipCode`, `status`).

## 2.8b — capacity drops through the worker, registration delete, repair script

- **Capacity drops are asynchronous.** When an access item fills up (its
  paid count reaches `maxCapacity`) or is deactivated, the request that did it
  no longer changes other registrations. The worker drops the item from each
  unsettled registration holding it (`PENDING`, `PARTIAL`, `VERIFYING`; not
  when a linked sponsorship covers it) a few seconds later. The admin sees
  `registration.updated` (or `registration.paymentConfirmed` when the drop
  leaves the registration fully sponsored) and `eventAccess.countsChanged`
  for each one as it happens, instead of in the same response. Lists and
  counts shown right after a confirmation or a deactivation may still include
  the item for a moment: rely on the realtime events to refresh.
- A drop now settles the registration like any other money change: a
  registration left fully covered by its sponsorship becomes `SPONSORED` and
  takes its paid places (before, only the status changed). The history entry
  (`ACCESS_CAPACITY_REACHED` / `ACCESS_DEACTIVATED`, by `SYSTEM`) may list
  `paymentStatus` too.
- A registration that already paid more than it would owe without the item
  keeps the item (no automatic overpayment); an admin handles it. Its
  history gets an `ACCESS_DROP_SKIPPED_OVERPAID` entry (by `SYSTEM`) with
  `accessKept` (item name → drop reason), `accessId`, `paidAmount`,
  `amountDue` and `amountDueWithoutAccess` (each in `new`); give it a label
  (e.g. "Access kept: already paid more than the amount due without it").
  An identical entry is not repeated when the drop is retried.
- **Registration delete:** a cancelled sponsorship linked to the deleted
  registration stays `CANCELLED` (before, it came back as `PENDING`).
- **Operators:** `repair-sponsorship-code-usages` no longer takes
  `--confirm-2-8-deployed`; links that fill an item are applied (the drop is
  enqueued). New `--clear-code --registration <id>... [--apply]` clears the
  stored code of the named registrations (history action
  `DATA_REPAIR_CLEAR_SPONSORSHIP_CODE`, by
  `SYSTEM:repair-sponsorship-code-usages`); give it a label in the
  registration history view.

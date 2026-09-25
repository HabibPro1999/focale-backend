# Frontend follow-up: meeting lifecycle and pending-request cap (4.7)

## Participant PWA

### New 409: one pending request per slot

A participant can have **one pending meeting request per slot**. A second request from the same
person for an overlapping slot now fails with **409 `NETWORKING_SLOT_CONFLICT`** and the message
"The requester already has a pending meeting request in this slot". This applies even when the
second request goes to someone else. It covers:

- `POST /api/networking/:slug/meetings` (new request);
- `POST …/meetings/:id/respond` with `RESCHEDULE` on a still-pending request, moving it onto a slot
  where its requester already has another pending request.

Show it like the other slot conflicts. Suggest cancelling the other pending request or picking
another time. The slot frees up again once that request is accepted, declined, cancelled or expires.
Requests the other side sends are not limited, and accepted meetings do not count.

### New: `data.reason` on cancellation notices

In-app notifications (and their push/email payloads) of type `MEETING_CANCEL` and `MEETING_CANCELLED`
now carry `data.reason`:

| `reason` | Meaning |
|---|---|
| `PARTICIPANT` | one of the two participants cancelled (`data.counterpartName` is present as before) |
| `ORGANIZER` | the organizer cancelled it |
| `UNAVAILABLE` | the meeting can no longer take place. This covers blocks, withdrawals, revoked consent or eligibility and moderation alike, and never says which. These notices have no `counterpartName`, `tableName` or `spaceName`. |

Older notifications have no `reason`; treat a missing value as unknown. Other notice types never
carry `reason`.

## Admin app

- Recording **COMPLETED** or **NO_SHOW** no longer frees the meeting's table and participants for the
  rest of the slot: the slot counts as used, the same as after a check-in. Calendar occupancy and
  remaining places now reflect that.
- An organizer **CANCEL** also withdraws a pending counter-proposal, and its notices carry
  `data.reason: "ORGANIZER"`.
- Table-balancing counts now include NO_SHOW meetings, like COMPLETED ones. This affects only which
  free table is tried first.

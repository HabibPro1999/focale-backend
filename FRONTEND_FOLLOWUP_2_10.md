# Frontend follow-up: check-in (2.10)

For the check-in app. The response shape of both endpoints is unchanged.

- **Offline sync is capped at 500 items per request.**
  `POST /api/events/:eventId/checkin/sync` now rejects a body with more than
  500 `checkIns` with 400 `VAL_2001` (VALIDATION_ERROR), and nothing is synced. Send the
  offline queue in slices of at most 500 and remove only the items of a slice
  that got a 200.
- **Parallel scans count once.** When two devices scan the same badge at the
  same time, one gets `alreadyCheckedIn: false` and the other
  `alreadyCheckedIn: true` with the first scan's `checkedInAt`. Before, both
  could report a new check-in. In a sync response, the item appears under
  `alreadyCheckedIn` instead of `synced`.
- **A registration that stops being settled between the read and the write**
  (e.g. refunded meanwhile) now gets 400 `CHK_17005` (CHECKIN_PAYMENT_REQUIRED) at event
  level instead of being checked in. In a sync response it appears in `errors`
  as "Registration payment is not settled".

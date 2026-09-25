# Frontend follow-up — 3.6 email delivery safety

Contract changes for the admin app (email logs).

## New email status `UNCERTAIN`

`EmailStatus` gains `UNCERTAIN`: the email provider may have taken the email,
but its answer never arrived (a timeout or dropped connection after the
request was sent, or a worker that stopped mid-send). Such an email is not
resent automatically, so the recipient gets it at most once.

- `GET /api/events/:eventId/email-logs`: rows can have `status: "UNCERTAIN"`
  (with an explanation in `errorMessage`), and `?status=UNCERTAIN` filters on
  it. Show it as its own state (for example "Unconfirmed"), not as failed or
  sent.
- `emailLog.statusChanged` realtime events can carry `status: "UNCERTAIN"`.
- An `UNCERTAIN` row can still move forward on its own when the provider's
  webhook confirms the email (`SENT`, `DELIVERED`, `OPENED`, `CLICKED`) or
  reports a bounce or drop (`BOUNCED`, `DROPPED`).
- Registration email lists that reuse `EmailStatusSchema` (the registration
  detail email history) can show the new value too.

## Resend an `UNCERTAIN` email

`POST /api/events/:eventId/email-logs/:emailLogId/resend` (no body; same
auth and "emails" module gate as the other email routes; 10 per minute).

- `201`: `{ "id": "<new email log id>", "status": "QUEUED", "resentFrom": "<emailLogId>" }`.
  The new log is sent by the worker within seconds. The `UNCERTAIN` log stays,
  with `errorMessage` "Resent by an admin as email log <id>".
- `404 RES_3001`: no such email log in this event.
- `409 RES_3002` with one of these messages:
  - "Only an UNCERTAIN email can be resent" (it is in another status, or a
    webhook just moved it forward);
  - "This email cannot be resent from its log; send it again from where it was
    sent" (one-off custom emails and committee invitations: their content is
    not stored in the log);
  - "An active email already covers this one" (it was already resent and that
    copy is still queued or sent, or another email for the same trigger is
    active).

Offer the action only on `UNCERTAIN` rows, and warn that the recipient may get
the email twice if the first one did go out.

## Health (monitoring only)

`GET /health/email-queue` gains `uncertainCount`. No client change.

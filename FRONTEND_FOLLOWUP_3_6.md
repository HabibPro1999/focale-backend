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

# 3.6b — send-now emails and the email-log list

## Custom email to a registrant

`POST /api/events/:eventId/registrations/:registrationId/send-custom-email`:
the `200` body gains `status`.

- `{ "success": true, "emailLogId": "…", "status": "SENT", "messageId": "…" }`:
  the provider accepted the email (as before, plus `status`).
- `{ "success": true, "emailLogId": "…", "status": "UNCERTAIN" }` (new): the
  provider did not answer (timeout, dropped connection). The email may have
  gone out; its log shows `UNCERTAIN` and moves on when the provider's webhook
  confirms it. Say "Sent, not confirmed yet: check the email log before
  sending it again" instead of "Sent". This email cannot be resent from its
  log (`409 RES_3002`); send it again from the registration only if the
  recipient did not get it.
- `502` when the provider refused it: unchanged (nothing was sent; the log is
  `FAILED`).

## Committee invitations and password links

- `inviteEmailSent` (add member, `POST …/abstracts/committee/:userId/reset-password`)
  is now `false` also when the provider did not confirm the email (it may
  still arrive). Same shape; the existing "email not sent, resend" wording
  still fits.
- The built-in invitation and password-link emails (used when no
  `ABSTRACT_COMMITTEE_INVITE` template is configured) now use the shared email
  layout: the event name in the header and the Focale footer.
- Password-link emails now get an email log too (not shown in the event's
  email-log list, like invitations).

## Event email-log list

`GET /api/events/:eventId/email-logs`:

- `meta.total` stops at 10,000. `meta.totalCapped: true` (new, always
  present) means there are more: show "10,000+" and don't rely on
  `totalPages`. Past the cap, `meta.hasNext` stays `true` while pages come
  back full.
- Rows with the same `queuedAt` are now ordered by id (newest first), so pages
  are stable.
- Rows and filters are unchanged.

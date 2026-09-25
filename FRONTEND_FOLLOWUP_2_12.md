# Frontend follow-up: certificate sends (2.12)

For the admin app (`SendCertificatesDialog`, `AbstractsSubmissionsPage`,
`src/features/certificates/hooks.ts`). Endpoint:
`POST /api/events/:eventId/certificates/send`. The changes are additive.

- **New per-abstract status `skipped_conflict`.** `abstracts.results[].status`
  can now be `"queued" | "already_sent" | "skipped_conflict" | "ineligible"`.
  `skipped_conflict` means the database refused the email row (a unique index)
  and nothing was queued for that abstract; sending again later is safe. Add it
  to `AbstractCertificateSendStatus`. The abstract page's toast currently shows
  the "ineligible" warning for any status it does not know; show a "could not
  be queued, try again" message instead. It counts in `abstracts.skipped`.
- **New top-level field `skippedConflict`** (number): the registrations whose
  email was refused the same way. It is already included in `skipped`, so
  `total - queued - skipped` is still the ineligible count. The dialog's
  "{{count}} skipped (already sent)" label can subtract it and show it
  separately.
- **`breakdown` counts only the certificates actually queued in this send.**
  Before, it counted every eligible certificate, including those skipped as
  already sent, so a repeated send showed full counts under "Certificates
  Queued" while `queued` was 0. Now a repeated send returns `breakdown: {}`.
- **Opened or clicked certificate emails count as sent.** A registrant or
  abstract whose certificate email was opened or clicked is reported as
  already sent (in `skipped` / `already_sent`) instead of getting the
  certificate again. Bounced, dropped, failed and skipped emails can still be
  resent.
- **One recipient can now receive several certificate emails.** An author with
  two presented abstracts, or a registrant who also presented an abstract, gets
  one email per abstract and one for the registration. Before, the second
  email made the request fail with 409 `RES_3002` (CONFLICT, "Resource
  already exists"). A registrant also gets a new
  email for a certificate template added after the first send (only the new
  certificate is attached).
- **Registrations and abstracts are queued together.** A request that sends
  both either queues both or fails as a whole (before, a failure in the
  abstract part left the registration emails queued). Parallel sends for the
  same event now run one after the other, so a double click queues each
  certificate once.
- **404 `RES_3001` (NOT_FOUND) "Event not found"** if the event is deleted
  while the send runs (rare).

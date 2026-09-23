# Networking delivery and maintenance

The worker owns a durable networking queue with five-minute renewable leases, bounded retries and progress recorded independently for email and each browser push endpoint. Claims atomically return complete rows and their exact lease timestamp; renewals, progress and begin/failed/skipped email-log writes compare that ownership fence under a row lock, retrying CockroachDB serialization restarts. A provider-confirmed send is recorded even after the lease was lost and upgrades a FAILED/SKIPPED log to SENT; failures in post-send bookkeeping never mark an accepted email failed or schedule a resend (the claim is abandoned to lease expiry instead). Every attempt revalidates event entitlement, consent, registration payment eligibility, symmetric blocks, message read state and meeting revision. Provider payloads use persisted contact/message records rather than stale notification text. Reminders recheck confirmed/upcoming state immediately before dispatch.

Networking emails have real `email_logs` records with the delivery UUID as their tracking ID. `contextSnapshot.dispatchOwner = "networking"` excludes these rows from the generic queue's claim and stale-lease recovery paths. Existing verified provider webhooks update delivery/open/click state; the networking worker does not downgrade a webhook that arrives before the provider response. Tracking snapshots contain identifiers and metadata, never OTPs, rendered email bodies, authenticator material or message snippets.

OTP delivery bypasses optional email preferences. Expired, consumed, email-mismatched or attempt-exhausted challenges cannot be sent. Successful and terminal failed/expired OTP deliveries remove encrypted code payloads. Provider errors are replaced with generic channel errors before persistence. Exactly-once acceptance across a provider call and database failure depends on provider idempotency support; the existing Resend provider sends the stable tracking ID as its idempotency key. SendGrid has no idempotency key, so a crash between its acceptance and the database write can resend the email (at-least-once). No local database transaction can make a remote provider call atomic.

The maintenance job runs once per minute:

- J-1 reminders are due in the 23–24-hour window; H-1 reminders are due within the upcoming hour. Meetings booked too recently for the relevant threshold do not receive obsolete reminders. A single database statement creates each localized in-app notification and delivery, deduplicated by type/meeting/revision/participant.
- Previous-event-local-day unread updates are summarized once after 08:00 in the event timezone. Read notifications, newly ineligible contacts, blocked relationships and stale meeting revisions are rechecked at dispatch. Current IMMEDIATE/DAILY/OFF preferences control email; browser push is a separate channel.
- Meeting/proposal expiration increments the revision. Short-lived sessions/challenges and exhausted OTP payloads are removed. Networking profiles are removed after the configured retention period even if an organizer previously disabled the module; registration records remain under the registration module's policy.
- A post-event report is queued once after the event has ended for 24 hours. The PDF contains aggregate metrics and sector counts, no participant identities or private conversations. It is stored privately as `networking/reports/<eventId>/<deliveryId>.pdf`. A `POST_EVENT_REPORT` audit record contains its storage key, generation time and aggregate summary. The authorized organizer GET endpoint supplies a short-lived signed URL. POST to the same `post-event-report` endpoint after event end requests an immediate UUID-versioned regeneration (202); concurrent requests reuse a pending/in-flight report. Each completed version has its own private object and audit record; GET returns the latest completed version. Manual regeneration does not wait 24 hours and may precede late check-ins.

Email defaults and meeting statuses support French, English and Arabic, with escaped organizer/user text, event timezone, branding and template variables. Organizer warning notes are preserved. Meeting confirmations/cancellations attach stable-UID, revisioned ICS files; active calendar entries include both day and hour alarms. Email accept/decline/reschedule links only express an intent in the authenticated PWA. The participant must review and explicitly confirm; GET links never mutate meetings.

## Client sending domains and participant contacts

`NETWORKING_EMAIL_SENDERS` is a server-owned JSON map keyed by client UUID. Each value has `provider` (`resend` or `sendgrid`, matching `EMAIL_PROVIDER`), `email`, `domainId`, and optional `name`. Example with synthetic values:

```sh
NETWORKING_EMAIL_SENDERS='{"client-uuid":{"provider":"resend","email":"networking@events.example.invalid","domainId":"domain-id","name":"Organizer"}}'
```

Without an entry, the platform sender is preserved. Overrides require the exact client allowlist identity and a verified provider domain matching the email domain. Resend must report `status=verified` and `capabilities.sending=enabled`; SendGrid domain authentication must report `valid=true`. Verification uses the provider key or optional `RESEND_DOMAIN_READ_API_KEY` / `SENDGRID_DOMAIN_READ_API_KEY` when sending-only credentials cannot read domains. Domain-read credentials remain server-side. Provider verification failures fail closed and use the queue retry policy. Positive verification is cached for five minutes; removing the client allowlist entry takes effect immediately. The organizer sender-status endpoint reports the address/status without exposing keys.

At or after event end +24 hours (after the +12-hour attendance window), maintenance creates one post-event connections notification per eligible participant. IMMEDIATE recipients receive a tracked UTF-8 CSV attachment; DAILY recipients receive it in the next event-local daily digest even if they already read the in-app notice. OFF recipients receive no email. The CSV contains public professional fields only, excludes blocked/ineligible/withdrawn contacts at dispatch, and neutralizes spreadsheet formula prefixes. No email/phone or private message text is included.

Configure the existing email provider/sender domain, `NETWORKING_TOKEN_SECRET`, `PUBLIC_NETWORKING_URL`, private storage provider and optional `NETWORKING_VAPID_*` keys for real delivery. Sender-domain verification and delivery/browser permission depend on those configured providers. No provider calls are made by the isolated tests.

## Verification

Unit regression suite:

```sh
pnpm --filter @app/integrations test
```

Real worker tests use the guarded per-file scratch database helper and the unified migration runner. Set `TEST_DB_ADMIN_URL` to a local disposable maintenance database with an exact `test` or `ci` token, then run:

```sh
ALLOW_DB_TESTS=1 TEST_DB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/focale_test_admin pnpm --filter @app/integrations test:db
```

The tests inject email, push and private-storage providers. They cover concurrent reminder deduplication, stale revisions, consent/block/payment changes, independent retries, OTP expiry/secrecy, digest preferences, generic queue ownership, webhook ordering, localized notes/ICS, disabled-module retention and idempotent private report generation. Event-scoped worker/maintenance arguments provide an additional fixture isolation boundary.

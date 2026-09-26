# Production rollout checklist

Everything batch 3 of the backend remediation (PRs #94 to #151) left for an
operator on the production deploy that ships it. Nothing here is automated.
One line per action, with the PR (and plan item) it comes from. Take a verified
database backup before the deploy; the data repairs need their own backup.

How the services run: [render-runbook.md](render-runbook.md).

## Before the deploy

- [ ] Config check passes in the API and the worker environment:
  `node packages/contracts/dist/cli/check-config.js` exits 0. New production
  rules: email provider key and sender, `PUBLIC_FORMS_URL`, explicit
  `CORS_ORIGIN`, `TRUST_PROXY` on both services, and `NETWORKING_TOKEN_SECRET`
  or `NETWORKING_KEYS` unless `NETWORKING_DISABLED=true`. #96 (3.1)
- [ ] Render `maxShutdownDelaySeconds` = 30 on both services;
  `SHUTDOWN_GRACE_MS` unset (25 s), or set so that it plus 3 s stays below the
  delay. #102 (3.2)
- [ ] Render health check path of the API is `/health/live`. #102 (3.2), #109 (3.3)
- [ ] The API runs one instance, no autoscaling ([single-instance.md](single-instance.md)). #120 (3.5)
- [ ] `REALTIME_DISABLED` has the same value on the API and the worker. #120 (3.5)
- [ ] The worker service runs, with `RUN_WORKERS` unset or not `"false"`:
  stale-lease recovery #114 (3.4a), retention #120 (3.5), capacity drops
  #132 (2.8b) and every queue depend on it.
- [ ] `NETWORKING_EMAIL_RATE_PER_SECOND` (default 5, per worker process) is
  below the email provider account's limit, with room for the other platform
  emails. Resend's default is 2 per second per team, so the default is too
  high there. #130 (4.2)
- [ ] The SendGrid Event Webhook (`/webhooks/sendgrid`) includes the
  **Processed** event, which moves an `UNCERTAIN` email (outcome unknown after
  its provider call) to `SENT` (Resend: the `email.sent` event). #123 (3.6a)
- [ ] The API has a writable temp directory for the check-in ZIP export
  (`os.tmpdir()`, about 0.2 MB per 10,000 registrations per workbook; `/tmp` in
  the image is writable by `node`). #144 (3.7b)

## Migrations 0021 to 0034

If the production database has no migration ledger yet, do the one-time
adoption first
([migrator README, Production rollout](../packages/db/src/migrator/README.md#production-rollout-operator-steps)).
Then `apply --dry-run` and `apply --yes`, as the Pre-Deploy Command or by hand
before the new code starts. Several of these must exist before the code that
uses them (0023, 0028, 0029, 0031), which the Pre-Deploy Command guarantees.

- [ ] 0021 `registration_reference_counters` table (empty; each prefix is
  seeded on first use). #106 (2.3)
- [ ] 0022 `networking_allocation_locks` table. #97 (4.1)
- [ ] 0023 `worker_heartbeats` table; until it exists, heartbeat writes fail,
  `/health/worker` answers 500 and `/health/ready` 503. #109 (3.3)
- [ ] 0024 rebuilds the two `email_logs` partial unique indexes without
  `CERTIFICATE_SENT` (per statement). #119 (2.12)
- [ ] 0025 networking retention columns (`purge_started_at`, `purged_at`,
  `erased_at`) and a withdrawn-profile index. #121 (4.4a)
- [ ] 0026 `email_logs` index on the networking event id. #121 (4.4a)
- [ ] 0027 outbox retention partial index. #120 (3.5)
- [ ] 0028 `EmailStatus` value `UNCERTAIN` (no transaction). #123 (3.6a)
- [ ] 0029 `email_logs.provider_attempted_at`, `provider`, and the
  `(template_id, queued_at)` index. #123 (3.6a)
- [ ] 0030 normalizes signup sponsorship codes and adds the
  one-registration-per-code unique index. Deferrable: `apply` records it as
  deferred while duplicates exist; finish it under Data repairs. #125 (2.7)
- [ ] 0031 networking delivery claim indexes and the erasure index; drops
  0025's withdrawn-profile index. #130 (4.2)
- [ ] 0032 `certificate_templates` render-image columns. #138 (3.8)
- [ ] 0033 drops `abstract_code_sequences`; the adopted production database
  still has the legacy table, and its rows go with it. #140 (6.5)
- [ ] 0034 `networking_interests` partial index for exhibitors' incoming likes
  (per statement, idempotent). The code works without it (slower), so it may
  follow the deploy. (4.9b)
- [ ] `verify --schema` reports no errors (deferred 0030, and 0017 on
  CockroachDB, are warnings).
- [ ] Once adopted: `MIGRATIONS_CHECK=enforce` on both services and the
  Pre-Deploy Command in place (migrator README, step 7).

The index builds in 0024 to 0031 and 0034 are plain `CREATE INDEX`, which briefly
blocks writes to the table on PostgreSQL; run `apply` off-peak there.

## After the deploy

- [ ] Expect the first networking maintenance run to purge every event already
  past its retention without `purged_at`, including events the old code
  emptied: their networking email logs and non-report audit rows are deleted
  too. #121 (4.4a)
- [ ] Expect the first maintenance run to erase every profile withdrawn more
  than `NETWORKING_WITHDRAWAL_ERASE_DAYS` (30) days ago. Profiles withdrawn in
  the 30 days before the deploy keep their hidden content until their own
  erasure date (the immediate scrub is not backfilled). #128 (4.4b)
- [ ] `/health/worker`, `/health/outbox` and `/health/email-queue` are 200;
  watch `uncertainCount`. #109 (3.3), #123 (3.6a)
- [ ] Certificate render images for templates uploaded before 0032:
  `backfill-certificate-renders` dry run, then `--apply`; then a visual check
  of real certificates from those templates (user). #138 (3.8)
- [ ] On CockroachDB, if 0017 is deferred: build the vector index in a
  maintenance window
  ([runbook](../NETWORKING.md#vector-index-health-and-runbook-cockroachdb)).
  #103 (4.10)
- [ ] Typed JSON columns (5.2a): keep `JSONB_VALIDATION=warn` (the default).
  Run the read-only audit `node apps/api/dist/scripts/stored-json-report.js`:
  it lists every stored pricing rule list, certificate zone list, form schema
  and email context that is not what its type says (row ids, paths and issue
  codes, never values). Pricing rules are typed in the public payment-config
  and form responses, so keys it reports as `unrecognized_keys` on
  `event_pricing.rules` are no longer returned there. Fix or accept each row
  (user); once the audit reports nothing, set `JSONB_VALIDATION=enforce` on
  both services. #165 (5.2a)

## Data repairs

Each is dry run, then sign-off by the user, then apply, after a verified
backup. In the image the scripts are
`node apps/worker/dist/scripts/<name>.js`; from a checkout,
`pnpm --filter @app/worker <name>`.

- [ ] Sponsorship codes (2.7): `repair-sponsorship-code-usages` dry run
  (planned links plus a decision list); the user decides each decision-list
  row and clears the losing or unknown codes with
  `--clear-code --registration <id>... --apply`; a new dry run; then
  `--apply --all` (or `--registration <id>...`) for the links; then
  `apply --apply-deferred=0030 --yes` once no event stores a code twice.
  #125 (2.7), #132 (2.8b)
- [ ] PAID settlement (2.4): `repair-paid-settlement --since <Nest deploy
  date, ISO>` dry run writes `repair-manifest.json`; the user sets each row's
  action in `approved.json`; `--apply --manifest approved.json`; then
  `repair-paid-settlement invariants` shows no rows
  ([PAID data repair](../README-rebuild.md#paid-data-repair-repair-paid-settlement-plan-24)).
  #136 (2.4)

## When needed

- Networking key rotation (`NETWORKING_KEYS`, `NETWORKING_KEYRING_WRITE_V1`,
  the `networking-keyring` script):
  [NETWORKING.md, Key rotation](../NETWORKING.md#key-rotation). #111 (4.5)
- Networking retention leftovers (`networking-retention purge-leftovers |
  erase-withdrawn | orphan-photos`, `--apply` needs `--backup-verified`):
  [NETWORKING.md, Retention operator scripts](../NETWORKING.md#retention-operator-scripts).
  #128 (4.4b)

The breaking API changes of each PR are listed in the `FRONTEND_FOLLOWUP_*.md`
files at the repository root; ship the matching admin, form and networking
builds with this deploy.

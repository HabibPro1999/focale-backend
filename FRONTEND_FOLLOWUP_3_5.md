# Frontend follow-up — 3.5 outbox retention and realtime hygiene

Contract changes for the admin app (`GET /api/stream`).

## `emailLog.statusChanged` may carry `ids`

Email status changes are now coalesced per 250 ms, and a batch send produces
one event per (event, status) instead of one per email:

```json
{ "type": "emailLog.statusChanged", "clientId": "...", "eventId": "...",
  "payload": { "id": "log-1", "status": "SENT", "ids": ["log-1", "log-2", "log-3"] } }
```

- `ids` present: every listed email log reached `status`; `id` is the first of
  them and there is no `registrationId`. Update (or refetch) every listed row,
  not only `id`.
- `ids` absent: unchanged shape (`id`, `status`, `registrationId` when the log
  belongs to a registration).
- Intermediate statuses inside a 250 ms window are not sent: a log may go from
  `QUEUED` straight to `SENT` on the client. Use the status in the event as the
  latest one; do not assume every transition is delivered.

## Replay after reconnect is per tenant

Nothing changes on the wire (`Last-Event-ID`, `event: replay-gap`), but the
server now keeps the last 500 events per client (organisation) instead of 500
across all clients, so another organisation's burst no longer causes a
`replay-gap` for yours. Keep refetching on `replay-gap` as today.

## Realtime delivery latency

The realtime pump now polls every second (was 5 s), so dashboard updates land
within about a second of the change.

## Health (monitoring only)

`GET /health/outbox` gains `counts.deadLetteredLast24h` and is unhealthy only
for rows dead-lettered in the last 24 hours (`counts.deadLettered` stays the
total). No client change.

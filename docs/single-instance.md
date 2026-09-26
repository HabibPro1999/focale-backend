# Single-instance constraint

Run **exactly one API instance**. Realtime fan-out, rate limiting and a few
caches live in the API process's memory. This is a deliberate decision of the
remediation plan: keep the in-process bus and the in-memory throttler, and
document the limit instead of building cross-replica fan-out. On Render: one
API instance, no autoscaling ([render-runbook.md](render-runbook.md)).

## API state that a second instance would split

| State | Code | With two instances |
|---|---|---|
| Admin realtime bus and replay rings: one EventEmitter, one ring of the last 500 events per tenant (`REPLAY_RING_SIZE`), SSE ids from a per-process counter | `apps/api/src/modules/realtime/bus.ts` | Each instance's realtime pump claims part of the realtime outbox rows and emits them only to its own `/api/stream` clients, so every client misses the events the other instance claimed. A `Last-Event-ID` from one instance means nothing to the other. |
| Realtime pump: claims `realtime.emit` and `networking.notify` rows every second | `apps/api/src/modules/realtime/realtime.pump.ts` | Same split as above; see [Realtime](../README-rebuild.md#realtime-single-api-instance). |
| Networking notification hub: participant streams keyed by (event, profile), woken in process after commit | `apps/api/src/core/networking-notification-hub.ts` | A participant connected to the other instance is not woken by this instance's commits; it catches up only at the stream's 60 s resync. |
| Participant stream limit: at most 3 open streams per session, the oldest replaced | `apps/api/src/modules/networking/networking.stream.ts` | The limit applies per instance. |
| Throttler storage: every `@nestjs/throttler` limit (global per-IP limit, networking venue buckets, per-session quotas) | `apps/api/src/core/core.module.ts`, `apps/api/src/core/networking-throttler.guard.ts` | Effective limits are up to N times higher, and each instance counts from zero. |
| Networking verified-bearer cache and invalid-bearer lockout | `apps/api/src/core/networking-identity-cache.ts` | A lockout on one instance does not apply on the other; an eviction (logout, withdrawal, suspension) reaches only the instance that handled it. Both only affect rate limiting: the session itself is checked on every request. The OTP failed-attempt sums are in the database and hold across instances. |
| Export limiter: `EXPORT_MAX_CONCURRENCY` running + `EXPORT_MAX_QUEUED` waiting | `ExportLimiter` in `apps/api/src/core/exports/stream-download.ts` | N times as many exports at once (memory and database load, not correctness). |
| Admin user cache: user and client rows, 60 s TTL | `apps/api/src/core/auth/user-cache.ts` | A role change, deactivation or client deactivation invalidates the cache only on the instance that handled it; the other keeps the old row for up to 60 s. |

Details of the rate limits: [NETWORKING.md, Rate limits](../NETWORKING.md#rate-limits).
Participant stream: [NETWORKING.md, Participant notification stream](../NETWORKING.md#participant-notification-stream).

## Per-process caches that are safe to duplicate

These only cost memory or allow short staleness, whatever the instance count:

- Certificate image LRU (`ByteLruCache`, 64 MB per process, in the worker's
  email queue): `packages/integrations/src/certificate-image-cache.ts`. Keys
  are never reused (every upload and backfill writes a fresh key), so a cached
  image is never stale.
- Networking recommendation candidates (30 s, 1,000 entries):
  `apps/api/src/modules/networking/networking-recommendation-cache.ts`.
- Networking sender verification (5 min):
  `packages/integrations/src/email/providers/networking-sender.ts`.
- Vector index presence check (60 s):
  `packages/db/src/queries/networking-vector-search.ts`.
- Firebase token lookup fallback (up to 5 min, only with
  `FIREBASE_AUTH_LOOKUP_FALLBACK`): `packages/integrations/src/firebase.ts`.

## The worker

The worker's queues (outbox, email queue, Abstract Book jobs, networking
deliveries and embedding jobs) are claimed with leases and
`FOR UPDATE SKIP LOCKED`, so a second worker process does not process a row
twice; plan item 4.2 (#130) tested two workers with six lanes each on
networking deliveries. Running more than one worker is still not a reviewed setup:

- `NETWORKING_EMAIL_RATE_PER_SECOND` is a token bucket per worker process, and
  the 429 back-off is per process too: two workers send up to twice the rate to
  the provider.
- Each worker holds its own 64 MB certificate image cache.
- The jobs other than the queues above (retention, maintenance, lease recovery)
  were not reviewed for running in parallel.

Run one worker service with one instance unless these are revisited.

## During a deploy

Render's zero-downtime deploy keeps the old API instance serving until the new
one passes its health check, then stops the old one within
`SHUTDOWN_GRACE_MS`. For those seconds two instances run: both pumps claim
realtime rows, the new instance's throttle counters start at zero, and replay
history starts empty (a restart does the same). Clients reconnecting to the new
instance get `event: replay-gap` and refetch. This is accepted.

## Scaling out later

Running several API instances would need, at least: a shared bus for the admin
realtime events and the participant notices (with ids every instance
understands, and a shared replay history), shared throttler storage, a
cross-instance invalidation for the user cache, and a cluster-wide export
limit. None of this is planned.

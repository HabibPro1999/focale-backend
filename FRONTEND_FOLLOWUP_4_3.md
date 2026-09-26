# Frontend follow-up — 4.3 participant notification stream

Contract changes for the networking PWA's `GET /api/networking/:slug/stream`
(same URL, same `Authorization: Bearer <session token>`). The server no longer
polls every 3 s: an in-process hub wakes the stream when the participant gets a
notification, and a 60 s resync covers anything else.

## Frames

| Frame | When | Client action |
|---|---|---|
| `event: ready`, `id: <cursor>`, `retry: <ms>`, `data: {}` | First frame of every stream | Keep the `id` (fetch-event-source does it) |
| `event: notifications`, `data: [row, …]` | New notifications | Merge by `row.id` (see below) |
| `event: replay-gap`, `data: {"lastEventId": "…"}` | The `Last-Event-ID` sent was unusable (not ours, or older than 24 h) | Refetch `GET /notifications` |
| `event: reconnect`, `data: {"reason": "lifetime" \| "error"}` | Stream lifetime reached (at most 30 min), or a server read failed | Reconnect at once with `Last-Event-ID` |
| `event: replaced`, `data: {"reason": "stream-limit"}` | A 4th stream opened for the same session | Do **not** reconnect this tab until it is visible/active again |
| `event: session-ended`, `data: {"code": "NETWORKING_…"}` | The 5-minute session check failed (logout, expiry, lost eligibility, MFA/consent now required, networking closed) | Handle `code` like the same error on any participant route; do not reconnect blindly |
| `event: shutdown`, `retry: <ms>`, `data: {"reconnectInMs": …}` | Deploy (unchanged from 3.2) | Reconnect after `reconnectInMs` |
| `: heartbeat` comment | Every `SSE_HEARTBEAT_MS` (25 s) when idle | None |

The server closes the response after `reconnect`, `replaced`, `session-ended`
and `shutdown`. Treat any other close as "reconnect" (with fetch-event-source,
throw from `onclose` so the library retries).

## Breaking changes

1. **`notifications` rows are oldest first** (id order, which follows creation
   order), in frames of at most 100 rows. The old stream sent newest first.
2. **Rows can repeat.** Delivery is at least once: after a reconnect the stream
   re-sends notifications created within about 10 s before the resume point
   (so a slowly committed notification is never missed). De-duplicate by `id`.
3. **Resume with `Last-Event-ID`.** Frames now carry an SSE `id` (a cursor;
   treat it as opaque). fetch-event-source sends the last one back on
   reconnect; the stream then replays everything created since, so the app no
   longer needs to refetch the list after every reconnect. Only the last frame
   of a burst carries the id; `ready` always does.
4. **The stream lasts up to 30 min** (was 60 s) and ends with
   `event: reconnect` `{"reason":"lifetime"}`.
5. **At most 3 open streams per session.** The newest wins: the oldest gets
   `event: replaced` and is closed. A client that blindly reconnects on
   `replaced` would evict another tab in a loop, so reconnect only when the tab
   is visible again.
6. **Session checks every 5 min** (was 30 s) and a failure is now reported as
   `event: session-ended` with the error code instead of a silent close.
7. **Heartbeats every 25 s** (was every 3 s when idle).
8. Opening the stream for a bad session still fails with an ordinary HTTP
   error before any frame (401 `NETWORKING_SESSION_EXPIRED`, 403 …), and with
   503 `SRV_5003` + `Retry-After` during a deploy (3.2).

## Latency

A notification created by a participant or organizer action reaches the stream
right after its transaction commits. One created by the worker or by
registration/payment processing arrives within about a second (outbox pump).
With `REALTIME_DISABLED` on the server, those arrive at the next 60 s resync.

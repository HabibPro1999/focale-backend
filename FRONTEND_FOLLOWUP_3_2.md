# Frontend follow-up — 3.2 shutdown and process lifecycle

Contract changes for the admin app (`GET /api/stream`) and the networking PWA
(`GET /api/networking/:slug/stream`).

## Streams end with `event: shutdown` on deploy

When an API instance stops (every deploy), each open stream receives one final
frame and is then closed by the server:

```
event: shutdown
retry: 2731
data: {"reconnectInMs":2731}
```

`reconnectInMs` (equal to `retry`) is jittered between 1 and 5 seconds so
clients do not reconnect all at once. Clients must:

- treat a normal close (the server ending the response) as "reconnect", not as
  "done": with `@microsoft/fetch-event-source`, throw from `onclose` so the
  library retries, or reopen the stream yourself;
- wait `reconnectInMs` before reconnecting after a `shutdown` frame (the
  `retry:` field already sets fetch-event-source's retry interval);
- keep sending `Last-Event-ID` on `/api/stream` reconnects (replay is
  unchanged).

## New connections during a restart get 503

A stream opened while the instance is draining is refused with HTTP 503,
`Retry-After: 5` and the error envelope code `SRV_5003`
(`SERVER_SHUTTING_DOWN`). Clients should retry after `Retry-After` seconds and
not show an error to the user for this code.

## Health

`GET /health/ready` returns 503 `{ "status": "draining" }` while an instance
shuts down (monitoring only; no client change).

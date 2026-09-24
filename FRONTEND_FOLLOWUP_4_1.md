# Frontend follow-up: networking write concurrency (4.1)

Networking writes no longer queue behind one lock per event. They run as
retried SERIALIZABLE transactions, and only meeting allocations lock the hours
they touch. Most changes are invisible; these are the ones a client can see.

## New: 503 `NETWORKING_BUSY` (PWA and admin networking pages)

- Any networking write (`/api/networking/:slug/...` and
  `/api/events/:eventId/networking/...`) can answer **HTTP 503** with
  `{ code: "NETWORKING_BUSY", message: "Networking is busy; retry in a moment" }`
  in the usual error envelope and a `Retry-After` header in seconds
  (currently `2`). It means the database kept refusing the write under
  contention after about 12 retries (a few seconds); **nothing was saved**.
- Clients should wait `Retry-After` seconds and resend the same request, at
  most a couple of times, and otherwise show "busy, try again" (not a generic
  error, not a sign-out). Resending is safe: messages are keyed by
  `clientMessageId`, and swipes, blocks and push subscriptions are idempotent.
  A meeting request that got 503 was not created.
- Expect it only in bursts (for example a room of attendees booking the same
  hour). A slow response of up to a few seconds before success is also
  possible then.

## Changed: lost booking races (409 `NETWORKING_SLOT_CONFLICT`)

- The code is unchanged. The message "This slot was just booked; choose
  another time" is no longer returned: a request that loses a race now gets
  "One of the participants already has a meeting in this slot" or "No table or
  exhibitor representative is available for this slot; choose another time",
  like a request that arrived later. Match on the code, not the message.
- Concurrent duplicates that could previously fail with a 500 now behave
  idempotently: a repeated message with the same `clientMessageId` returns the
  stored message, repeated swipes/blocks succeed, and a mutual like announces
  one match (one `MATCH` notification per side).

## Changed: withdrawal cancellation notices

When a participant withdraws (`DELETE me`), the notices sent for their
cancelled meetings now match every other involuntary cancellation (block,
suspension, eligibility change):

- `type` stays `MEETING_CANCELLED`; `title` is "Meeting cancelled" and `body`
  "This meeting is no longer available." (previously "Meeting update" /
  "Meeting cancelled for <ISO time>.").
- `data` is `{ meetingId, revision, action: "CANCEL", status: "CANCELLED",
  startsAt, endsAt }`; the previous `tableName` / `spaceName` keys are gone.
  The counterpart is still never named.

## Changed: push subscription ownership

`POST push-subscriptions` for an endpoint already registered to another
participant now moves that subscription (same `id`, new owner, keys and
expiry) instead of deleting it and creating a new row. The response shape is
unchanged; only the returned `id`/`createdAt` are the original ones.

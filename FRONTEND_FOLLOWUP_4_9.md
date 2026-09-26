# Frontend follow-up — 4.9 networking read paths

## 4.9a Organizer analytics (`GET /api/events/:eventId/networking/analytics`)

Same URL and access. The figures are now SQL aggregates that share their
definitions with the post-event report (PDF). Admin app: `AnalyticsPanel`,
`OperationalAnalytics`, `ParticipantsPanel`.

### Changed

1. **`engagement` holds the 50 most engaged participants**, not every
   participant: most booked meetings first, then matches, messages and swipes.
   New field **`engagementTotal`**: the number of listed participants. The
   engagement table's hint already points to the participants export for the
   full list; show "top 50 of `engagementTotal`" when `engagementTotal > 50`.
   `ParticipantsPanel` falls back to `engagement.find(profileId)` for match and
   meeting counts: the profiles list already carries `matchCount` and
   `meetingCount`, so rely on those (a participant outside the top 50 has no
   `engagement` row).
2. **`likes` and `passes` count the interests as they stand** (the report's
   "interests" figure), not every swipe gesture: a like later changed into a
   pass counts as one pass, and passes a participant reset no longer count.
   `matchRate` and `interestReciprocityRate` use these likes. In an engagement
   row, `swipes` and `likes` are the participant's interests (one per target).
   `hourlyActivity` still counts every swipe.
3. **Row order**: `sectors` largest first (then by name), `zones` busiest first
   (then by name), `tableUsage` by table name. Sort client-side if another order
   is wanted.

Unchanged: every other field and its definition (the golden test holds them to
the old calculator).

## 4.9b Lists, exports and the agenda

### Participant PWA: incoming interests (`GET /api/networking/:slug/interests/incoming`)

**Now paginated like connections and meetings.** Query `limit` (1–200,
default 50) and `cursor` (opaque); the response is
`{ items, nextCursor, total? }`: newest like first, `total` on the first page
only, `nextCursor` null on the last page. Items keep their shape
(`{ id, profile, createdAt }`). An invalid `limit` or a cursor from another
list answers 400 `NETWORKING_VALIDATION`.

`IncomingInterests.tsx` reads `Page<IncomingInterest>` with one request, so it
now shows only the 50 newest likes. Switch it to `api.list("/interests/incoming")`
with `PaginationContinuation`, as for connections, and keep the client-side
search on the loaded pages (or say that it searches the loaded likes).

Unchanged: exhibitors only (403 `NETWORKING_FEATURE_DISABLED` otherwise); the
senders shown are the ones the exhibitor may open (visible with a complete
profile while discovery is on, or connected; never blocked either way).

### Admin: participant, meeting and report lists (pagination shape)

`GET /api/events/:eventId/networking/profiles`, `…/meetings` and `…/reports`:

- Query: `page` (from 1, default 1) and `limit` (1–100, default 30), plus the
  existing filters (profiles: `q`, `sector`, `status`, `activity`; meetings:
  `q`, `date`, `status`, `tableId`; reports: `status`). Unchanged.
- Response: `{ items, total }`, `total` counting every row that matches the
  filters. Unchanged; items keep their shapes (profiles with `matchCount` and
  `meetingCount`; meetings with `requester`, `recipient` and
  `table` (with `space`); reports with `reporter`, `profile` and `message`).
- **Order is now fixed**: participants oldest first (by creation, then id; the
  old order was the database's storage order), meetings by start time then id
  (as before), reports newest first then id (as before). Sort client-side for
  another order within a page, or ask for a server sort.
- The meeting search still folds case and accents (precomposed and decomposed
  Latin accents, Arabic diacritics), now in SQL. Marks of other scripts are no
  longer folded.

### Admin: exports (`GET …/networking/export?kind=&format=`)

- CSV is now streamed like XLSX: no `Content-Length`, the same bytes (BOM,
  quoting, CRLF). PDF unchanged.
- **Participants export, "Swipes" column**: the participant's interests as
  they stand (the analytics definition of 4.9a), no longer every swipe gesture
  in the history. "Matches", "Messages" and "Planned meetings" are unchanged.
- Row order: participants oldest first and matches oldest first (both were in
  storage order); meetings unchanged (by start time).

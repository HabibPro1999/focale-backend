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

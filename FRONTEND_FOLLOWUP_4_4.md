# Frontend follow-up: networking retention (4.4a)

## Admin networking pages

### GET `/api/events/:eventId/networking/audit` lists organizer actions only

The response shape is unchanged (`{ items, total }`, `page` and `limit` as before, newest first),
but participant activity is no longer returned: `SWIPE_LIKE`, `SWIPE_PASS`, `MFA_*` and
`PROFILE_VIEW` rows are personal data. The listed actions are:

`CONFIG_UPDATED`, `PROFILE_UPDATED`, `MEETING_ASSIGN`, `MEETING_CANCEL`, `MEETING_COMPLETED`,
`MEETING_NO_SHOW`, `REPORT_DISMISS`, `REPORT_RESOLVE`, `REPORT_WARN`, `REPORT_SUSPEND`,
`REPORT_EXCLUDE`, `SPACE_CREATED`, `SPACE_UPDATED`, `SPACE_REMOVED`, `TABLE_CREATED`,
`TABLE_UPDATED`, `TABLE_REMOVED`, `POST_EVENT_REPORT`, `POST_EVENT_REPORT_REGENERATE`.

Drop any audit filter or label that relies on the participant actions. `total` counts only the
listed actions.

### New 409 on the networking config

`PATCH /api/events/:eventId/networking/config` answers **409 `NETWORKING_RETENTION_ENDED`** when the
change would enable networking and either:

- the event's retention period has ended (`endDate + retentionDays`, using the `retentionDays` sent
  in the same request) and networking is currently disabled; or
- the retention purge has already started (networking data is being or has been deleted).

Show it as a final state: "The retention period of this event has ended; networking can no longer
be enabled." Other edits to a disabled config are still accepted. Nothing was saved.

Once retention ends, the event's networking data (participants, messages, meetings, notifications,
participant audit rows and networking email logs) is deleted within minutes; admin lists and
analytics for that event become empty. The post-event report stays available.

## Participant PWA

No contract change. After `DELETE /me` the profile photo is now deleted by a background job with
retries (seconds later) instead of during the request.

# Frontend follow-up: withdrawal erasure (4.4b)

Withdrawal is final. `DELETE /api/networking/:slug/me` keeps its response (`{ withdrawn: true }`),
but the participant's networking data now goes in two stages: their profile content (company, job
title, sector, bio, city, country, website, photo, interests, offers, seeks) is cleared at once,
and after `NETWORKING_WITHDRAWAL_ERASE_DAYS` (default 30 days) everything else is erased.

## Admin networking pages

### New 409 when editing a withdrawn participant

`PATCH /api/events/:eventId/networking/profiles/:id` answers **409 `NETWORKING_PROFILE_WITHDRAWN`**
when the participant has withdrawn (`withdrawnAt` is set). Nothing is saved (no status change, no
field edit, no audit entry). Disable the edit and status actions for withdrawn participants and
show "This participant withdrew from networking."

### Withdrawn participants in lists and exports

- `GET /api/events/:eventId/networking/profiles` and the participants export still list a withdrawn
  participant during the erasure window, but with empty professional fields, `photoUrl: null`,
  `interests: []`, `visible: false`, `consent: false`, `meetingsEnabled: false` and
  `emailPreference: "OFF"`. Name, email and status stay until the erasure.
- After the erasure the participant no longer appears in the list, its `total`, or the exports.
  Their meetings, reports, conversations and audit entries are gone too, so meeting, report and
  analytics counts for the event can drop.
- `GET /api/events/:eventId/networking/recommendations/status`: `jobs` no longer counts withdrawn
  participants (their embeddings are deleted at withdrawal).

## Participant PWA

- After the erasure, other participants lose everything shared with the erased participant:
  the connection and its whole conversation, past and cancelled meetings with them, and the
  notifications about that connection or those meetings. Lists simply no longer contain them;
  handle a 404 on a stale connection or meeting link as "no longer available".
- A withdrawn participant cannot sign in again with the same registration (unchanged).

# Frontend follow-up: networking sync runs in the background (4.8)

## Admin — networking settings

### `POST /api/events/:eventId/networking/sync` now answers 202 with a run

The sync no longer runs inside the request. It starts a run in the worker, which re-projects the
event's registrations in chunks, and answers **202** at once. Before, it answered 201 with
`{ created, updated }` after every registration had been synced.

The response (`data`, in the usual envelope) is the new run's state:

```json
{
  "runId": "0192…",
  "status": "RUNNING",
  "total": 1840,
  "processed": 0,
  "created": 0,
  "updated": 0,
  "failed": 0,
  "requestedAt": "2026-09-26T10:00:00.000Z",
  "finishedAt": null,
  "lastError": null
}
```

| Field | Meaning |
|---|---|
| `runId` | the run's id; a new request starts a new run and replaces the one in progress |
| `status` | `IDLE` (no sync was ever requested, or networking was never configured for the event), `RUNNING`, `COMPLETED` |
| `total` | registrations of the event when the run was requested |
| `processed` | registrations handled so far (may end slightly above `total` if people registered during the run) |
| `created` / `updated` | profiles created / updated by the run |
| `failed` | registrations whose sync failed during the run; each one is retried on its own in the background, so it is not lost |
| `requestedAt` / `finishedAt` | ISO timestamps; `finishedAt` is set when `status` becomes `COMPLETED` |
| `lastError` | the last failure while the run is being retried; cleared when it moves on. While it is set the run is not stuck for good: the worker retries it with backoff |

An event without a networking configuration answers 202 with `status: "IDLE"` and `runId: null`.
Nothing is started, because there is nothing to project.

### New: `GET /api/events/:eventId/networking/sync`

Returns the same state for the latest run (same auth as the other networking admin reads). Poll it
after the POST (every 2–5 s is plenty) until `status` is `COMPLETED`. Show progress as
`processed / total`. When `failed > 0`, say that a few registrations are being retried. When
`lastError` stays set, say that the sync is retrying.

### Behaviour to reflect in the UI

- Replace any "N created, M updated" toast shown after the POST with a progress indicator driven by
  GET. The final counts are in the completed state.
- Saving a config change that affects every profile (enabling networking, approval mode, eligible
  payment statuses, field mapping) now starts the same background run instead of syncing during the
  save. The PATCH response is unchanged. The page can show the run's progress through GET `/sync`.
- A registration's networking profile now appears or updates a few seconds after the registration is
  created, paid, edited or linked to a sponsorship, not in the same request. Screens that list profiles
  right after such a change (e.g. an admin flow that confirms a payment and then opens the networking
  participants page) may need a refresh or a short poll.

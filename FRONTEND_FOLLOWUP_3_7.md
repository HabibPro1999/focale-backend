# Frontend follow-up — 3.7 streaming exports

Contract changes for the admin app's report downloads:

- `GET /api/events/:eventId/reports/registrations?format=csv|json|xlsx`
- `POST /api/events/:eventId/reports/registrations/export` (modular workbook)
- `GET /api/events/:eventId/reports/summary`
- `GET /api/events/:eventId/reports/access-registrants`
- `GET /api/events/:eventId/reports/sponsorships`
- `GET /api/events/:eventId/reports/checkin-export`

(3.7b adds the abstracts and networking exports to the same rules.)

## New 503 `EXPORT_BUSY` (with `Retry-After`)

Each API instance runs 2 exports at once and queues 4 more for up to 30 s.
Beyond that, or after 30 s in the queue, the request fails with HTTP 503,
`Retry-After: 10` and the error envelope:

```json
{ "ok": false, "error": { "code": "EXPORT_BUSY", "message": "Too many exports are running; retry shortly" } }
```

Show a "busy, retrying" state and retry after `Retry-After` seconds (a few
attempts), or tell the user to try again in a moment. It is not a failure of
the export itself.

During a deploy, a new export may instead get 503 `SRV_5003`
(`SERVER_SHUTTING_DOWN`, `Retry-After: 5`), as for streams since 3.2: retry.

## Downloads are streamed: no `Content-Length`

Successful responses keep the same `Content-Type` and
`Content-Disposition: attachment; filename="..."` headers but are sent chunked
without `Content-Length`, and the first bytes arrive before the whole file is
built. So:

- a progress bar cannot know the total size: show an indeterminate progress (or
  bytes received) instead of a percentage;
- read the body to the end before saving (`await response.blob()` does); if
  reading the body fails (network error, `TypeError: terminated`, aborted
  stream), the export failed on the server or the connection dropped: show an
  error and do not save a partial file. A complete response always ends
  cleanly;
- a request timeout, if the HTTP client sets one, must cover the whole
  download (large exports can take several seconds), not only the time to the
  first byte;
- cancelling the download (aborting the fetch) now stops the export on the
  server and frees its slot.

Errors found before the file starts (404 event not found, 403, validation)
still answer with the usual JSON error envelope and status.

## File content

- Row order is newest submission first as before; registrations submitted at
  the same instant are now always in the same order (by id).
- XLSX cells that held an empty string are now written as empty inline
  strings; they still show as empty cells. Workbooks are about a third larger
  (no shared-string table); columns, styles, filters, frozen rows and merged
  headers are unchanged.
- CSV and JSON bodies are byte-for-byte what they were.

# Frontend follow-up: duplicated helpers (6.4)

No endpoint or shape change. Two small response differences:

- **A missing stored file is 404 on R2 too.**
  `GET /api/events/registrations/:id/payment-proof` and
  `GET /api/events/certificates/:id/image` answered 500 when the object was gone from R2; they now answer
  404 `RES_3001` (NOT_FOUND), as they already did on Firebase. Any other
  download of a missing object that is not handled also maps to 404 `RES_3001`
  instead of 500. Show a "file not found" state rather than a generic error.
- **Abstract titles are trimmed everywhere.** The committee abstract list now
  returns the trimmed title, and a blank title shows `Untitled abstract` (the
  admin views, exports, the Abstract Book and certificates already did). The
  `{{submissionTitle}}` email variable is trimmed too and stays empty when the
  abstract has no title.

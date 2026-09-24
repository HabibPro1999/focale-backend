# Frontend follow-up — 3.1 config consolidation + error filter

Contract changes for the admin, public form and networking repos.

## Integration failures return their own 4xx code (admin, public form)

Errors raised by the integrations layer (`IntegrationError`) used to reach
clients as `500 SRV_5001 "Internal server error"`. They now keep their own
status, code and message in the standard error envelope.

Known cases today:

| Endpoint | Trigger | Before | After |
|---|---|---|---|
| `POST /api/events/:id/banner` (admin) | image the decoder rejects (over 20 megapixels, corrupt, undecodable) | 500 `SRV_5001` | 400 `FIL_10001` (`INVALID_FILE_TYPE`), message "Invalid image. Upload a valid image of at most 20 megapixels." |
| `POST /api/public/registrations/:id/payment-proof` (public form) | same | 500 `SRV_5001` | 400 `FIL_10001` (`INVALID_FILE_TYPE`), same message |

Clients should show the returned message (or their own copy for
`FIL_10001`) instead of a generic server-error toast, and must not retry these.

## CORS (no client change expected)

Production `CORS_ORIGIN` must list explicit origins; `*` and wildcard hosts
are rejected at boot. Origins are matched in canonical form
(`https://admin.example.com`, no trailing slash or path), which is exactly what
browsers send. No request change is needed; a deployed front end whose origin
is missing from `CORS_ORIGIN` keeps failing CORS as before.

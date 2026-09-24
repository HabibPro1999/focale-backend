# Frontend follow-up: networking rate limits (0.9)

No new error codes. Every new limit answers HTTP 429 with the existing shape:
participant PWA routes use `{ code: "NETWORKING_RATE_LIMITED" }`, organizer
routes keep the generic `RATE_4001`. What changes is when a 429 can happen.

## Networking PWA (`/api/networking/:slug/...`)

- **Unknown bearers.** A bearer the API has not verified in the last 5 minutes
  (after an API restart, after 5 idle minutes, or a revoked/garbage token)
  shares a per-IP-and-event bucket of 12,000 requests/min until its first
  successful request. Tokens issued by `auth/verify` count as verified at once.
  Verified sessions keep their existing per-session limits.
- **Invalid-bearer lockout.** After 200 distinct rejected bearers
  (unknown, revoked or expired sessions) from one IP for one event within 10
  minutes, unverified bearer requests from that IP get 429 for 10 minutes, with
  a `Retry-After` header (seconds). Signed-in sessions the API already verified,
  the sign-in routes (`auth/request`, `auth/verify`, `auth/mfa/verify`) and
  `config`/`registration` are not blocked. The PWA should keep treating 401 as
  "session ended" (it already clears the session) and treat 429 as "retry
  later", not as a sign-out.
- **OTP verification.** `POST auth/verify` returns 429
  `NETWORKING_RATE_LIMITED` ("Too many verification attempts") once an email
  has 10 failed code attempts in 15 minutes or 30 in 24 hours for that event,
  summed across all its challenges. The code is not checked while limited, so a
  correct code also gets 429. Show a "too many attempts, try again later"
  message instead of "wrong code"; requesting a new code does not reset it.

## Admin networking pages (`/api/events/:eventId/networking/...`)

- All organizer networking routes together are capped at 600 requests/min per
  client IP (on top of the existing per-token limits). Staff scanning badges
  behind one venue IP share this budget. Over the cap: 429 `RATE_4001`.

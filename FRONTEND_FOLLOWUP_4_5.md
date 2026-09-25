# Frontend follow-up: networking keyring (4.5)

Participant PWA only. The admin app needs nothing.

## New: `recoveryCodesOutdated` after an MFA check

`POST /api/networking/:slug/auth/mfa/verify` and `POST …/auth/mfa/confirm` now also return
`recoveryCodesOutdated: boolean` next to `verified`. The new `…/recovery-codes` route returns it too;
`DELETE …/auth/mfa` (disable) does not.

- `true` means the participant's remaining recovery codes were created with a key the organizers are
  retiring. They still work for now. Offer "Generate new recovery codes" (below) after sign-in, and
  explain that the old codes stop working once replaced.
- `false` (or absent) needs no action.

## New: regenerate recovery codes

`POST /api/networking/:slug/auth/mfa/recovery-codes` with `{ "code": "<authenticator or recovery code>" }`,
the same body as `auth/mfa/verify`. It uses the same session rules and the same 10/minute per-session
limit.

- Success: `{ verified: true, recoveryCodes: string[10], recoveryCodesOutdated: false }`. It replaces
  **all** previous recovery codes. It counts as the session's MFA check, like `verify`. Show the new
  codes once, with the existing "save these codes" UI from enrollment.
- A wrong or reused code gets 400 `NETWORKING_VALIDATION`, as `verify` does. A recovery code used here
  is consumed.

## Changed: token and badge formats (opaque; no parsing)

Once operators enable the new key format, the badge token (`GET badge`, `token`) signature and sealed
values change shape, e.g. `<payload>.v1:k1:<hex>`. Treat badge tokens, QR payloads and session tokens as
opaque strings: never split or validate them client-side beyond passing them back. The existing
`#badge=<token>` fragment link keeps working: `:` is valid in a URL fragment.

## Unchanged

Sign-in, session tokens and existing badges keep working through the key rotation. Sessions move to
the new key on their next request. No participant is logged out by the rollout, except by a rollback
to a pre-keyring build after new keys were enabled (operator runbook in `NETWORKING.md`).

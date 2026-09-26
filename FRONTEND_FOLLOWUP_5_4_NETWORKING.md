# Networking tenant guards and response contracts (5.4 / 5.5)

## Organizer access checks

All 28 organizer routes under `/api/events/:eventId/networking` (including recommendation status/reindex) now use the shared event tenant guard. Authentication still runs first. The guard then checks missing event, tenant ownership, archived status for writes, and client/module availability, in that order, before body/query validation. Public participant, OTP and MFA authorization continues through the networking participant/session policy.

| Condition | Before | After |
|---|---|---|
| Missing event | 404 `RES_3001` | Same |
| Another client's event | 403 `AUTH_1004` | Same |
| Write to archived event | 400 `STT_12001` | Same; now precedes module checks |
| Inactive client | 403 `CLT_20001` | Same |
| Networking module disabled | 403 `CLT_20002` | Same |
| Another tenant plus invalid body/query | Body/query validation could answer 400 first | Tenant refusal answers 403 first |

The original module-gate follow-up still applies: add `CLT_20001` and `CLT_20002` to the admin French/English error dictionaries before production (see `FRONTEND_FOLLOWUP_5_4.md`). No new error code is introduced here.

## JSON responses

All 74 networking JSON routes now declare closed output schemas. Existing documented row fields, optional omissions, nulls, dates and envelopes remain unchanged. Undeclared fields are removed recursively; development/test also validates the projected response. Stored extensible JSON values (`overrides`, audit/notification `data`) retain their existing contents. Participant-facing profile projections keep the existing privacy exclusions; self-profile and organizer responses retain their existing fields.

Raw CSV/XLSX/PDF downloads, calendar ICS, the personal JSON download, and SSE keep their explicit envelope exemptions. Generated JSON Schema and TypeScript artifacts include the new response schemas; adopt those artifacts when updating frontend types. No frontend edit is required for a currently valid response. Smoke-test directory/recommendations, chat, meetings/calendar, OTP/MFA and organizer configuration after deployment.

No migration, new environment variable or operator action is introduced by this item. The open PARTIAL public-form payment decision is unchanged.

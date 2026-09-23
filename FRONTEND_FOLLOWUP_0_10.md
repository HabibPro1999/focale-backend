# Frontend follow-up: unavailable networking block profiles

`GET /api/networking/:slug/blocks` keeps the block row and `targetId`, but may
return `profile: null` when the target is missing or no longer eligible, or
when profile visibility requires a connection that does not exist. Keep using
`targetId` to unblock these entries and handle the missing profile in the list.

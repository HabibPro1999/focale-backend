# Frontend follow-up: extra reviewers follow the divergence alert (5.3)

No endpoint, response shape or error-code change.

`POST /api/events/:eventId/abstracts/:abstractId/assign` (assign reviewers)
now allows more than `reviewersPerAbstract` reviewers exactly when the
score-divergence alert would fire: at least two active reviews are scored,
their spread is above zero, and it is at least `divergenceThreshold`.

Only a `divergenceThreshold` of **0** changes. There, the API used to accept
extra reviewers with fewer than two scores or with all scores equal; both now
get the same 400 as any other refused extra (`VALIDATION_ERROR`, "Extra
reviewers can only be assigned after a score divergence alert"). Thresholds of
1 and above behave as before.

**Admin** (`AbstractsSubmissionsPage.tsx`, `canAssignExtraReviewers`): the
page already refuses extras when `scoreSpread.spread` is null (fewer than two
scores), but at threshold 0 it still enables saving extras when the spread is
0, which the API now refuses. Require a spread above zero as well:

```ts
const canAssignExtraReviewers =
  detail?.scoreSpread.spread != null &&
  detail.scoreSpread.spread > 0 &&
  detail.scoreSpread.spread >= (config?.divergenceThreshold ?? Number.POSITIVE_INFINITY);
```

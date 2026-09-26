# Continuous integration

The `CI` workflow runs on PRs into `develop`, pushes to `develop`, and manual
dispatch. Its planner uses the full PR diff (merge base to head) or complete
push range, without GitHub's path-filter file limits. Deleted files and both
sides of renames count. Missing history or an unknown path requests all checks.

| Change | Checks selected |
|---|---|
| Root Markdown or Markdown/images under `docs/` only | Planner tests and required gate; no dependency install, build or database |
| Workspace unit tests or ESLint rules/config only | Static checks |
| Database, concurrency or migration test files only | Static checks plus the corresponding tier on both engines |
| API/worker/integration source; DB queries, settlement, policy, outbox, lease queue or operational code | Static checks plus database and concurrency tiers on both engines |
| Migrations/schema, DB connection/test infrastructure, shared/contracts packages, dependencies, launchers/container, CI or other paths | All 12 existing checks, plus planner and required gate |
| Manual run | All checks regardless of paths |

Mixed changes take the union of the required checks. Shared layers deliberately
use the full suite because they can affect migration/configuration behavior.
The static job retains typecheck, lint, build, generated-artifact checks, unit
and runtime tests, and the dependency audit. Selected DB tiers retain the same
engines, shard counts, per-file database isolation and safety guards.

`CI / required` is the stable aggregate check. It runs even after another job
fails and accepts only success for selected jobs; unselected jobs may skip.
CockroachDB failures are blocking, matching the project's all-selected-checks
acceptance rule. Repository branch-protection settings are not changed.

New commits cancel older runs for the same PR. Push/manual runs stay independent
so cancelling an intermediate push cannot leave untested changes outside the
next push's diff. Push validation stays enabled, including after merges: it also
covers direct pushes, and successful PR metadata alone does not prove which
merge tree was tested. There is no scheduled extra run.

CockroachDB jobs no longer start an unused PostgreSQL service. Timeouts bound
stuck work: planner/gate 5 minutes, static/image 20 minutes, DB tiers 45 minutes.

## Maintenance

```bash
node --test scripts/ci-plan.test.mjs
actionlint .github/workflows/ci.yml
gh workflow run ci.yml --ref develop # full suite, explicitly requested
```

The planner tests cover tier selection, mixed and unknown paths, full/manual
fallback, complete multi-commit diffs, renames, unusual filenames and gate
failure handling. New runtime directories default to full coverage until their
dependencies are understood and a narrower rule is tested.

Skipping is done at job level. Avoid adding workflow-level `paths-ignore`:
[GitHub keeps required checks pending when a whole workflow is filtered out](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore).

# Main → develop catch-up

Source: `main` / `origin/main` at `8cdbd52`. Target before this port:
`develop` / `origin/develop` at `39330c5`. Shared ancestor: `37b9646`.
Remote refs were fetched before comparison. The 13 non-merge commits unique to
main were reviewed and their behavior ported into the Nest/Drizzle workspace.
The archived Fastify/Prisma `src/` tree remains a reference; it is not the Nest
runtime. This is a semantic port, not a merge of the legacy application.

| Main commits | Nest implementation |
| --- | --- |
| `9c1adde`, `f221245` | Auth verification failure logging; Identity Toolkit fallback when Firebase public-key retrieval fails. Keeps disabled-user and revocation checks; the fallback request has a 10-second timeout. |
| `73be63e` | Author affiliation up to 500 characters, co-author names up to 200, co-author affiliation up to 500; validation failures logged without request bodies. |
| `5041fde`, `24a1a04` | `in` conditions; contradiction detection; option-ID validation on pricing/access saves. Unchanged legacy pricing conditions are grandfathered through rename/reprice/delete/bulk updates. |
| `e27a103`, `e5ad53d` | French/English/Arabic sidecar translations for form fields, options, steps, sponsor summaries, success text, abstract themes, and language settings; editable multilingual registration-fee label. |
| `1706f6d` | Drizzle check-in columns use `timestamptz(3)` to match the applied legacy schema. A forward migration aligns fresh Nest databases. |
| `25bf7fd`, `3043a84` | Hashed invite tokens, configurable seven-day lifetime, single-use claims, public verify/set-password/resend routes, admin resend/override cleanup. Separate Nest invite and email services preserve existing template lookup and email audit tracking. |
| `660c87f` | Effective presentation-type filter (final decision, otherwise requested type); unpaginated XLSX export using the same filters, dynamic reviewer columns, escaped cells and download filenames. Shared French labels and author formatting. |
| `30dcc52`, `8cdbd52` | Undated access and all ADDONs use `addonGroup.slots`; deterministic order, same-type exclusivity with included/existing-selection exemptions; optional required-selection enforcement on public create and access edits. |

Develop-specific fixes retained include Tunisia-local access date buckets,
committee account eligibility and cross-client password-reset restrictions,
abstract deadline/theme validation, and configured invite templates/email logs.
The options response intentionally changes from `addonGroup.items` to
`addonGroup.slots`, matching the current main frontend contract.

## Database rollout

New manual migrations, following the existing repository convention:

1. `0007_multilanguage_forms.sql`: nullable JSONB translation/language columns.
2. `0008_committee_invite_tokens.sql`: token table with inline uniqueness/FKs.
3. `0009_committee_invite_lookup_index.sql`: secondary lookup index.
4. `0010_checkin_timestamptz.sql`: UTC-preserving check-in type alignment.

The unified runner applies these in filename order; `0008` commits before
`0009` to avoid CockroachDB's new-table schema-lock issue. These SQL files are
manual migrations, and the old Drizzle journal and `drizzle-kit migrate` path
have been removed. Existing databases must be adopted before `apply` will
proceed. Adoption is deferred to plan item 1.4 in this branch, so do not apply
these migrations to an existing database yet or reapply the `0000` baseline.
The development rollout is recorded below.

`COMMITTEE_INVITE_TOKEN_TTL_DAYS` defaults to 7. `ADMIN_APP_URL` is the base for
`/committee/set-password`. `FIREBASE_WEB_API_KEY` retains main's public project
identifier default and can be overridden for another Firebase project.

## Verification

- `pnpm build`: passed for all six workspace packages/apps.
- `pnpm typecheck`: passed.
- `pnpm test`: 1,246 passed; four existing opt-in timezone tests skipped.
- Disposable local PostgreSQL: all migrations applied from scratch; migration
  suite passed 23 tests, including reapplying the new migrations.
- Dedicated database regression suite: nine tests passed, covering simultaneous
  claims/mints, claim compensation, cross-event cleanup, list/export parity,
  and multilingual persistence.
- HTTP regression tests cover public invite validation, 410 error codes, stray
  authorization headers, strong-password validation, and resend throttling.
- Export tests open the generated XLSX and check content and formula escaping.

Live Firebase/email delivery and deployed admin browser QA were not run.

## Development rollout — 2026-09-07

- Confirmed `.env` and `.env.prod` have different `DATABASE_URL` values and
  different database hosts. Both database names are `defaultdb`; their shared
  name does not indicate the same configured target. Both connections succeeded.
- Reapplied `0007`–`0009` idempotently to the development CockroachDB v26.2.5
  target from `.env`. The columns, table and indexes already existed.
- Verified `0010` was already satisfied: both check-in columns are timestamptz.
  No type rewrite was necessary.
- Verified three JSONB columns, eight invite-token columns, two invite foreign
  keys, the primary/unique/lookup indexes, and both check-in timestamp types.
- No production writes were performed. Neither environment file was modified
  or included in Git.

# Legacy test suites (read-only reference)

The unit, DB, concurrency and migration suites of the legacy Bun app in
`src/`, kept on `develop` only as a reference.

- **The runnable legacy app and its test configs live on `main`**
  (`vitest.config.ts`, `vitest.db.config.ts`, `vitest.concurrency.config.ts`,
  `vitest.migration.config.ts`). No Vitest config on `develop` includes this
  directory, so these tests are not run here, locally or in CI.
- The workspace tests sit next to their code (`apps/*/src/**/*.test.ts`,
  `packages/*/src/**/*.test.ts`), plus the DB, concurrency and migration tiers
  in `packages/db/tests/` (`pnpm test`, `pnpm test:db`, `pnpm test:concurrency`,
  `pnpm test:migration`).

Don't add tests here.

# Backend workspace commands

The pnpm workspace contains `apps/*` and `packages/*`. Use Node.js 24 or newer
and the pinned pnpm 10.12.1. Run these commands from the backend root:

| Command | Scope |
| --- | --- |
| `pnpm typecheck` | All workspace packages, including `packages/db/tests/` |
| `pnpm test` | Workspace unit suites, one package at a time |
| `pnpm build` | Production builds in dependency order |
| `pnpm --filter @app/api exec tsc --noEmit` | API source and test types |
| `pnpm --filter @app/api test` | API unit suite |
| `pnpm --filter @app/db typecheck` | DB source and the separate DB test tree |
| `pnpm env:example --check` | Build contracts and check `.env.example` for drift |

The package names are `@app/api`, `@app/worker`, `@app/contracts`, `@app/db`,
`@app/integrations` and `@app/shared`; substitute the package name for focused
checks. DB's plain `tsc --noEmit` covers its source config; its `typecheck`
script also runs `tests/tsconfig.json`.

The root `tsconfig.json` serves the retained legacy `src/` tree. Workspace
packages extend `tsconfig.base.json` and have their own source/build configs.
Likewise, root `vitest.config.ts` and the root DB/concurrency/migration configs
target legacy tests. Select a workspace package with `pnpm --filter` when
running Vitest directly, or use the workspace scripts above. In an editor,
select the Vitest config inside the package being tested.

Root `vitest.unit.setup.ts` is an exception to that legacy naming: workspace
unit suites use it to replace `DATABASE_URL` with a fixed test URL. Keep that
setup in the configured unit-test chain.

## Database tiers

`pnpm test:db`, `pnpm test:concurrency` and `pnpm test:migration` run separate
tiers. They need `ALLOW_DB_TESTS=1` and a guarded `TEST_DB_ADMIN_URL`; they skip
without the opt-in. These suites create and drop disposable databases. Follow
the [DB test helper guide](db/src/testing/README.md) for URL restrictions,
engine requirements and setup; unit-test success does not verify these tiers.

## Package entry points

Workspace source checks and test configs select the `@app/source` export
condition. Production builds clear that condition and consume built package
exports. Use package imports for shared code; DB test helpers are exposed as
`@app/db/testing` and `@app/db/testing/fixtures` only under `@app/source`.
Neither testing entry point has a production export.

This guide describes existing commands. The legacy tree and its configuration
remain separate; no test, build or lint policy is changed here.

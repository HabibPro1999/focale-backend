# Legacy app source (read-only reference)

This is the source of the legacy single-process Bun/Fastify/Prisma backend,
kept on `develop` only as a reference while its behavior is ported.

- **The runnable legacy app lives on `main`**, with its own `package.json`,
  Bun lockfile, Prisma config and Vitest configs. Run, fix or deploy it there.
- **Nothing here is built, type-checked, linted, tested or deployed from
  `develop`.** The root `tsconfig.json` only references `apps/*` and
  `packages/*`, `pnpm lint` covers `apps` and `packages`, no Vitest config
  includes this directory, and the Docker image excludes it (`.dockerignore`).
- `tsconfig.legacy.json` at the repo root is the legacy TypeScript config
  (`@/…`, `@core/…` and module path aliases), kept for reading this code.
  The legacy dependencies are not installed here, so it does not type-check.

Don't edit this directory. The backend that runs from `develop` is the pnpm
workspace in `apps/` and `packages/` (see `README-rebuild.md`).

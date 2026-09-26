# Legacy Prisma schema and migrations (read-only reference)

The Prisma schema and migrations of the legacy Bun app, kept on `develop` only
as a reference.

- **The runnable legacy app lives on `main`** (with `prisma.config.ts` and the
  Prisma CLI scripts). Nothing here is generated, migrated, tested or deployed
  from `develop`, and the Docker image excludes it (`.dockerignore`).
- The workspace schema is Drizzle (`packages/db/src/schema/`) and its
  migrations are `packages/db/migrations/*.sql`, run by the unified migrator
  (`packages/db/src/migrator/README.md`). When the migrator adopts a database
  the legacy app created, it reads that database's `_prisma_migrations` table,
  not these files.

Don't add or edit migrations here.

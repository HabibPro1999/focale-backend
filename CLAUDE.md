# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

- **Default branch**: `develop` (always work here)
- **Production branch**: `main` (deploy via PR)
- **Deployment**: Merge to main → GitHub Actions auto-deploys
- See `docs/git-workflow.md` for complete workflow

## Commands

```bash
# Development
bun run dev              # Start dev server with hot reload
bun run start            # Run production build

# Code quality
bun run type-check       # TypeScript type checking
bun run lint             # Run ESLint
bun run lint:fix         # Fix ESLint issues

# Testing
bun run test             # Run tests in watch mode
bun run test:run         # Run tests once
bun run test:coverage    # Run tests with coverage report

# Database
bun run db:generate      # Generate Prisma client
bun run db:push          # Push schema to database (dev only)
bun run db:migrate       # Create and apply migrations (dev)
bun run db:migrate:prod  # Apply migrations (production)
bun run db:status        # Check migration status
bun run db:verify        # Run data integrity checks
```

## Architecture

This is a **modular monolith** backend using Fastify with enforced module boundaries.

### Path Aliases

- `@/*` → `src/*`
- `@config/*` → `src/config/*`
- `@core/*` → `src/core/*`
- `@shared/*` → `src/shared/*`
- `@modules/*` → `src/modules/*`
- `@identity`, `@clients`, `@events`, `@forms`, `@pricing` → Module barrel exports

**Important**: Always use `.js` extensions in imports (ES modules requirement).

### Core Layer (`src/core/`)

- `server.ts` - Fastify instance with Zod type provider, decorates `app.prisma`
- `plugins.ts` - CORS, Helmet, rate limiting, @fastify/sensible
- `hooks.ts` - Request ID lifecycle hooks
- `shutdown.ts` - Graceful shutdown with Prisma disconnect

### Shared Layer (`src/shared/`)

- `types/fastify.d.ts` - Type augmentation for Fastify (`AppInstance`, `request.user`, `app.prisma`)
- `errors/app-error.ts` - Custom error class with `statusCode`, `code`, `details`
- `errors/error-codes.ts` - Enumerated codes: `AUTH_*`, `VAL_*`, `RES_*`, `RATE_*`, `SRV_*`, `PRC_*`
- `middleware/error.middleware.ts` - Global error handler (handles Zod, AppError, rate limit)
- `utils/logger.ts` - Pino logger with redaction
- `utils/pagination.ts` - Shared pagination utility (`paginate()`, `getSkip()`)

### Modules Layer (`src/modules/`)

Feature modules with enforced boundaries. Each module should:

1. Have a barrel export (`index.ts`)
2. Add path alias to `tsconfig.json`: `"@{module}": ["./src/modules/{module}/index.ts"]`
3. Add ESLint boundary rule in `eslint.config.js`

Internal structure per module:

- `{domain}.schema.ts` - Zod schemas (use `.strict()`)
- `{domain}.service.ts` - Business logic (one table per service)
- `{domain}.routes.ts` - HTTP handlers (routes orchestrate services)

### Key Patterns

#### Route Definition (IMPORTANT)

Use Fastify's native schema validation instead of manual parsing:

```typescript
// CORRECT - Use schema option, Fastify validates automatically
app.post<{ Body: CreateUserInput }>(
  "/",
  {
    schema: { body: CreateUserSchema },
    preHandler: [requireAuth],
  },
  async (request, reply) => {
    // request.body is already validated and typed
    const user = await createUser(request.body);
    return reply.status(201).send(user);
  },
);

// WRONG - Don't manually parse
app.post("/", async (request, reply) => {
  const input = CreateUserSchema.parse(request.body); // Don't do this
});
```

#### Type Usage

- Use `AppInstance` type (from `@shared/types/fastify.js`) instead of `FastifyInstance`
- Use `Prisma.ModelGetPayload<{include: {...}}>` for accurate return types with includes

#### Error Handling

Use `@fastify/sensible` for simple HTTP errors:

```typescript
throw app.httpErrors.notFound("User not found");
throw app.httpErrors.forbidden("Insufficient permissions");
throw app.httpErrors.badRequest("Invalid input");
```

Use `AppError` for business errors with codes:

```typescript
throw new AppError(
  "Sponsorship code already used",
  409,
  true,
  ErrorCodes.CONFLICT,
  { code },
);
```

#### Pagination

Use the shared pagination utility:

```typescript
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";

const skip = getSkip({ page, limit });
const [data, total] = await Promise.all([
  prisma.user.findMany({ skip, take: limit }),
  prisma.user.count({ where }),
]);
return paginate(data, total, { page, limit });
```

#### Database

- Prisma singleton at `src/database/client.ts`, accessible via `app.prisma`
- Config: Zod-validated env vars at `src/config/app.config.ts`
- Cross-module imports: Only through barrel exports, enforced by ESLint

#### Client Module Access Control

Clients have an `enabledModules` field controlling which event features they can access:

```typescript
// Available modules (defined in @clients)
MODULE_IDS = ["pricing", "registrations", "sponsorships", "emails"];
```

- **Forms page** is derived: visible if `registrations` OR `sponsorships` enabled
- **One-way enable**: modules can be added but never removed (merge on update)
- **Default**: new clients get all 4 modules enabled

## Database Migration Rules (CRITICAL)

### ✓ ALWAYS DO

1. **Review migration SQL before applying**

   ```bash
   # Create migration WITHOUT auto-applying
   bun x prisma migrate dev --create-only --name my_change

   # Review the generated SQL file
   cat prisma/migrations/*/migration.sql

   # If safe, apply with: bun run db:migrate
   ```

2. **Test thoroughly in development first** (we don't have staging)

   ```bash
   # Test in dev database
   bun run db:migrate
   bun run db:verify
   bun run test

   # Backup production before applying
   pg_dump $(grep DATABASE_URL .env.prod | cut -d '=' -f2) > backup-$(date +%Y%m%d-%H%M%S).sql

   # Apply to production (off-peak hours only)
   env DATABASE_URL=(grep DATABASE_URL .env.prod | cut -d '=' -f2) bun run db:migrate:prod
   env DATABASE_URL=(grep DATABASE_URL .env.prod | cut -d '=' -f2) bun run db:verify
   ```

   **See `docs/migrations.md` for complete guide.**

3. **Use versioned migrations**
   - Use `bun run db:migrate` in development (creates migration files)
   - Commit migration files to git
   - Use `bun run db:migrate:prod` in production (applies pending migrations)
   - GitHub Actions automatically deploys migrations to production

4. **Run integrity checks after migrations**

   ```bash
   bun run db:verify  # Runs scripts/verify-data-integrity.ts
   ```

5. **Follow the pre-migration checklist**
   - See `docs/migrations.md` for complete workflow
   - Backup production before every migration
   - Plan rollback strategy

### ✗ NEVER DO

1. **Never use `db:push` in production**
   - `db:push` bypasses migration history
   - Only for rapid prototyping in development
   - Production MUST use `db:migrate:prod`

2. **Never skip SQL review for destructive operations**
   - Column renames generate `DROP COLUMN` + `ADD COLUMN` (data loss!)
   - Type changes may truncate data
   - Making columns required fails if NULLs exist
   - Always manually edit migrations for renames:
     ```sql
     -- Instead of Prisma's DROP+ADD:
     ALTER TABLE "users" RENAME COLUMN "biograpy" TO "biography";
     ```

3. **Never apply migrations directly to production from local machine**
   - Use GitHub Actions workflow (`.github/workflows/deploy-migrations.yml`)
   - Or explicitly use staging/production env files
   - Never run `bun run db:migrate` with production DATABASE_URL in your `.env`

4. **Never modify committed migration files**
   - Migration history is immutable
   - Create new migrations to fix issues
   - Use `prisma migrate resolve` for failed migrations

5. **Never skip thorough testing** (we don't have staging)
   - Test migrations extensively in dev database
   - Run full test suite before production
   - Deploy during off-peak hours only
   - Always backup production before migrations

### Dangerous Operations Checklist

When migrations include any of these, use **expand-contract pattern**:

- [ ] Renaming columns (generates DROP+ADD)
- [ ] Changing column types (may lose precision)
- [ ] Making nullable → required (fails if NULLs exist)
- [ ] Dropping columns with data
- [ ] Splitting/merging tables

**Expand-Contract Pattern:**

1. **Expand**: Add new column/table alongside old
2. **Dual-write**: Application writes to both
3. **Backfill**: Copy old data to new structure
4. **Switch reads**: Application reads from new
5. **Contract**: Remove old column/table

See `docs/migrations.md` for detailed examples.

### Environment Files

- `.env` - Development database (auto-loaded by Bun)
- `.env.prod` - Production database (manual load or GitHub Actions)
- Never commit `.env.prod` to git
- We don't have staging environment - extra caution required

### Testing

Tests use Vitest with Fastify's `inject()` method:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp, cleanupDatabase } from "../helpers/test-app.js";

describe("Users API", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/users/me returns current user", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
```

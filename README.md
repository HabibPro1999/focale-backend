# DUO Backend

Event registration platform API built as a modular monolith with Fastify.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun 1.x |
| Framework | Fastify 5.x |
| Type System | TypeScript 5.7+ |
| Validation | Zod 4.x |
| Database | Prisma 7.x (CockroachDB) |
| Auth | Firebase Admin |
| Logging | Pino 10.x |

## Getting Started

```bash
# Install dependencies
bun install

# Configure environment
cp .env.example .env

# Generate Prisma client
bun run db:generate

# Push schema to database
bun run db:push

# Start development server
bun run dev
```

## Environment and Test Safety

- Copy `.env.example` to `.env` for local development, then replace placeholders with local-only values.
- Never commit real `.env*` files; only `.env.example`, `.env.test.example`, `.env.test.db.example`, and `.env.test.migration.example` are intended to be tracked.
- Production secrets belong only in the deployment secret manager. If production-like credentials are found in local env files, rotate them in the owning service and remove local copies.
- Unit tests load `.env.test` when present and otherwise use safe in-code defaults. They never fall back to `.env`, and `DATABASE_URL` is forced to a dummy local test URL for the mocked unit tier.
- DB-backed test tiers load only `.env.test.db`/`.env.test.migration` or process env. They require `ALLOW_DB_TESTS=1` plus `TEST_DATABASE_URL` or `TEST_MIGRATION_DATABASE_URL`, and refuse database names that do not clearly contain `test` or `ci`.
- Useful validation: `git check-ignore -v .env .env.prod .env.test .env.test.db .env.test.migration`, `git check-ignore -v .env.example .env.test.example .env.test.db.example .env.test.migration.example`, `bun run type-check`, `bun run lint`, and `bun run test:run`.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run dev:worker` | Start background worker with hot reload |
| `bun run start` | Run production build |
| `bun run start:worker` | Run production background worker |
| `bun run type-check` | TypeScript type checking |
| `bun run lint` | Run ESLint |
| `bun run test` | Run mocked unit tests in watch mode |
| `bun run test:run` | Run mocked unit tests once |
| `bun run test:unit` | Alias for the fast mocked unit test run |
| `bun run test:db` | Run opt-in DB integration tier (`ALLOW_DB_TESTS=1` + `TEST_DATABASE_URL`) |
| `bun run test:concurrency` | Run opt-in real-DB concurrency tier |
| `bun run test:migration` | Run opt-in migration tier (`TEST_MIGRATION_DATABASE_URL`) |
| `bun run test:ci` | Type-check plus unit tests only |
| `bun run test:ci:db` | Type-check, unit, DB, concurrency, and migration tiers when DB env is present |
| `bun run test:coverage` | Run mocked unit tests with coverage |
| `bun run db:generate` | Generate Prisma client |
| `bun run db:push` | Push schema to database |
| `bun run db:migrate` | Run migrations |

## Architecture

### Module Dependency Graph

```
          LEAF MODULES (0 dependencies)
          ═══════════════════════════════
            clients    access    pricing    reports

               ↑          ↑         ↑
               │          │         │
        ┌──────┘          │         │
        │                 │         │
     events ◄─────────────┼─────────┤
        ↑                 │         │
        │                 │         │
     forms            identity      │
        │                 │         │
        └────────┐  ┌─────┘         │
                 ↓  ↓               │
             registrations ◄────────┘
                 │    │
          ┌──────┘    └──────┐
          ↓                  ↓
     sponsorships         email
```

### Module Responsibilities

| Module | Purpose | Exports |
|--------|---------|---------|
| **core/outbox** | Durable side effects, retries, worker dispatch | `enqueueOutboxEvent`, `processOutboxEvents`, `startRealtimeOutboxPump` |
| **identity** | Users, roles, auth | `UserRole`, `usersRoutes` |
| **clients** | Tenant organizations, module access | `clientExists`, `MODULE_IDS`, `clientsRoutes` |
| **events** | Event CRUD, capacity | `getEventById`, `eventExists`, `eventsRoutes` |
| **forms** | Dynamic form schemas | `getFormById`, `formsRoutes` |
| **registrations** | Submissions, payments | `getRegistrationById`, `registrationsRoutes` |
| **sponsorships** | Lab sponsorship codes | `sponsorshipsRoutes` |
| **access** | Event sessions/extras | `validateAccessSelections`, `accessRoutes` |
| **pricing** | Pricing rules engine | `calculatePrice`, `pricingRoutes` |
| **email** | Templates, queue, delivery | `queueTriggeredEmail`, `emailRoutes` |
| **reports** | Financial reports, exports | `reportsRoutes` |
| **realtime** | Authenticated SSE stream for admin dashboards | `realtimeRoutes`, `drainRealtimeConnections` |

### Runtime Workers

The web process owns HTTP routes, SSE connections, and the realtime outbox pump. The realtime pump claims only `realtime.emit` outbox rows and emits them to the process-local SSE event bus.

The background worker process (`bun run start:worker`) owns non-realtime outbox rows, email queue delivery, and abstract book jobs. When web and worker are split, run the web process with `RUN_WORKERS=false`; do not run realtime outbox processing in the standalone worker.

### Database Schema

```
CLIENT (Tenant)
  └─► USER (admin accounts)
  └─► EVENT
        ├─► FORM (registration/sponsor schemas)
        │     └─► REGISTRATION
        │           └─► EMAIL_LOG
        ├─► EVENT_ACCESS (sessions, workshops)
        ├─► EVENT_PRICING (rules, bank info)
        └─► SPONSORSHIP_BATCH
              └─► SPONSORSHIP
                    └─► SPONSORSHIP_USAGE

AUDIT_LOG (immutable, no FKs)
```

### Authorization Pattern

```
Request → requireAuth middleware
            ↓
        Verify Firebase token
            ↓
        Lookup user in DB
            ↓
        canAccessClient(user, resourceClientId)
            ↓
        SUPER_ADMIN: always allowed
        CLIENT_ADMIN: only if user.clientId === resourceClientId
```

### Client Module Access

Each client has `enabledModules` controlling which event features they can access:

```
MODULE_IDS = ['pricing', 'registrations', 'sponsorships', 'emails']
```

| Behavior | Description |
|----------|-------------|
| **Forms derived** | Forms page visible if `registrations` OR `sponsorships` enabled |
| **One-way enable** | Modules can be added but never removed |
| **Default** | New clients get all 4 modules |

## Project Structure

```
src/
├── index.ts              # Entry point
├── config/
│   └── app.config.ts     # Zod-validated env vars
├── core/
│   ├── server.ts         # Fastify setup, route registration
│   ├── plugins.ts        # CORS, Helmet, rate limiting
│   ├── hooks.ts          # Request lifecycle hooks
│   └── shutdown.ts       # Graceful shutdown
├── database/
│   └── client.ts         # Prisma singleton
├── modules/
│   ├── identity/         # Users, permissions
│   ├── clients/          # Tenant organizations
│   ├── events/           # Event management
│   ├── forms/            # Dynamic forms
│   ├── registrations/    # Submissions
│   ├── sponsorships/     # Sponsorship codes
│   ├── access/           # Event sessions
│   ├── pricing/          # Pricing engine
│   ├── email/            # Email system
│   └── reports/          # Reporting
└── shared/
    ├── middleware/       # Auth, error handling
    ├── errors/           # AppError, error codes
    ├── services/         # Firebase service
    ├── types/            # Fastify augmentation
    └── utils/            # Logger, pagination
```

## Module Rules

| Rule | Reason |
|------|--------|
| Use `.js` in imports | ES modules requirement |
| Cross-module via barrel only | Enforced by ESLint |
| Routes orchestrate services | Clear responsibility |
| One table per service | Clean boundaries |

## Adding a Module

1. Create folder: `src/modules/{module}/`
2. Create files:
   - `{module}.schema.ts` - Zod schemas
   - `{module}.service.ts` - Business logic
   - `{module}.routes.ts` - HTTP handlers
   - `index.ts` - Barrel export
3. Add path alias to `tsconfig.json`:
   ```json
   "@{module}": ["./src/modules/{module}/index.ts"]
   ```
4. Register routes in `src/core/server.ts`

## Testing

The project uses **Vitest** with comprehensive unit test coverage for all modules.

### Test Infrastructure

| Component | Purpose |
|-----------|---------|
| `vitest-mock-extended` | Deep mocking for Prisma client |
| `@faker-js/faker` | Test data factories |
| `@vitest/coverage-v8` | Code coverage reporting |

### Test Files

```
tests/
├── mocks/
│   ├── prisma.ts          # Prisma client mock
│   ├── firebase.ts        # Firebase Auth/Storage mocks
│   └── sendgrid.ts        # SendGrid email mock
├── helpers/
│   ├── factories.ts       # Unit test factories for all models
│   ├── auth-helpers.ts    # Authentication test utilities
│   ├── test-app.ts        # Fastify test instance
│   ├── test-env.ts        # Safe unit/DB/migration env guards
│   ├── db.ts              # Real DB reset/disconnect helpers
│   └── db-fixtures.ts     # Minimal real DB seed helpers
├── integration/
│   └── health.test.ts     # Health check tests
├── db/                    # Opt-in DB integration tests (*.db.test.ts)
├── concurrency/           # Opt-in real-DB concurrency tests
├── migration/             # Opt-in migration smoke tests
├── setup.ts               # Mocked unit tier setup
├── setup.db.ts            # Guarded real-DB tier setup
└── setup.migration.ts     # Guarded migration tier setup

src/modules/*/
└── *.service.test.ts      # Co-located unit tests
```

### Coverage Summary

| Module | Tests |
|--------|-------|
| Identity | 34 |
| Clients | 34 |
| Events | 37 |
| Forms | 38 |
| Pricing | 19 |
| Access | 51 |
| Registrations | 53 |
| Sponsorships | 64 |
| Email (3 services) | 113 |
| Auth Middleware | 36 |
| **Total** | **481** |

### Running Tests

Tests are tiered so the default workflow stays fast and mocked. No test tier loads `.env` implicitly.

```bash
# Watch mode for fast mocked unit tests
bun run test

# Single fast mocked unit run (CI/default)
bun run test:run
bun run test:unit

# With unit coverage report
bun run test:coverage
```

DB-backed tiers are explicit and guarded. Prepare a disposable CockroachDB/PostgreSQL-compatible database whose database name contains `test` or `ci`, then provide env from process env or the matching template file.

```bash
# DB integration tier
ALLOW_DB_TESTS=1 TEST_DATABASE_URL='postgresql://...' bun run test:db

# Real-DB concurrency tier
ALLOW_DB_TESTS=1 TEST_DATABASE_URL='postgresql://...' bun run test:concurrency

# Migration tier against a separate disposable database
ALLOW_DB_TESTS=1 TEST_MIGRATION_DATABASE_URL='postgresql://...' bun run test:migration
```

Use `.env.test.example` only for unit-safe overrides, `.env.test.db.example` for DB tiers, and `.env.test.migration.example` for migration smoke tests. Keep all values local/disposable placeholders; never place production or shared development credentials in test env files.

### Writing Tests

```typescript
import { prismaMock } from '../../../tests/mocks/prisma.js';
import { mockAuthenticatedUser } from '../../../tests/helpers/auth-helpers.js';
import { createMockClient } from '../../../tests/helpers/factories.js';

describe('MyService', () => {
  it('should do something', async () => {
    const mockClient = createMockClient();
    prismaMock.client.findUnique.mockResolvedValue(mockClient);

    const result = await myService.getClient(mockClient.id);

    expect(result).toEqual(mockClient);
  });
});
```

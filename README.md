# Focale OS — Backend

Event registration platform API built as a modular monolith with Fastify.

## Tech Stack

| Layer       | Technology               |
| ----------- | ------------------------ |
| Runtime     | Bun 1.x                  |
| Framework   | Fastify 5.x              |
| Type System | TypeScript 5.7+          |
| Validation  | Zod 4.x                  |
| Database    | Prisma 7.x (CockroachDB) |
| Auth        | Firebase Admin           |
| Logging     | Pino 10.x                |

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

## Scripts

| Script                  | Description                      |
| ----------------------- | -------------------------------- |
| `bun run dev`           | Start dev server with hot reload |
| `bun run start`         | Run production build             |
| `bun run type-check`    | TypeScript type checking         |
| `bun run lint`          | Run ESLint                       |
| `bun run test`          | Run tests in watch mode          |
| `bun run test:run`      | Run tests once                   |
| `bun run test:coverage` | Run tests with coverage          |
| `bun run db:generate`   | Generate Prisma client           |
| `bun run db:push`       | Push schema to database          |
| `bun run db:migrate`    | Run migrations                   |

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

| Module            | Purpose                             | Exports                                       |
| ----------------- | ----------------------------------- | --------------------------------------------- |
| **identity**      | Users, roles, auth                  | `UserRole`, `usersRoutes`                     |
| **clients**       | Tenant organizations, module access | `clientExists`, `MODULE_IDS`, `clientsRoutes` |
| **events**        | Event CRUD, capacity                | `getEventById`, `eventExists`, `eventsRoutes` |
| **forms**         | Dynamic form schemas                | `getFormById`, `formsRoutes`                  |
| **registrations** | Submissions, payments               | `getRegistrationById`, `registrationsRoutes`  |
| **sponsorships**  | Lab sponsorship codes               | `sponsorshipsRoutes`                          |
| **access**        | Event sessions/extras               | `validateAccessSelections`, `accessRoutes`    |
| **pricing**       | Pricing rules engine                | `calculatePrice`, `pricingRoutes`             |
| **email**         | Templates, queue, delivery          | `queueTriggeredEmail`, `emailRoutes`          |
| **reports**       | Financial reports, exports          | `reportsRoutes`                               |

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

| Behavior           | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| **Forms derived**  | Forms page visible if `registrations` OR `sponsorships` enabled |
| **One-way enable** | Modules can be added but never removed                          |
| **Default**        | New clients get all 4 modules                                   |

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

| Rule                         | Reason                 |
| ---------------------------- | ---------------------- |
| Use `.js` in imports         | ES modules requirement |
| Cross-module via barrel only | Enforced by ESLint     |
| Routes orchestrate services  | Clear responsibility   |
| One table per service        | Clean boundaries       |

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

| Component              | Purpose                        |
| ---------------------- | ------------------------------ |
| `vitest-mock-extended` | Deep mocking for Prisma client |
| `@faker-js/faker`      | Test data factories            |
| `@vitest/coverage-v8`  | Code coverage reporting        |

### Test Files

```
tests/
├── mocks/
│   ├── prisma.ts          # Prisma client mock
│   ├── firebase.ts        # Firebase Auth/Storage mocks
│   └── sendgrid.ts        # SendGrid email mock
├── helpers/
│   ├── factories.ts       # Data factories for all models
│   ├── auth-helpers.ts    # Authentication test utilities
│   └── test-app.ts        # Fastify test instance
├── integration/
│   └── health.test.ts     # Health check tests
└── setup.ts               # Global test setup

src/modules/*/
└── *.service.test.ts      # Co-located unit tests
```

### Coverage Summary

| Module             | Tests   |
| ------------------ | ------- |
| Identity           | 34      |
| Clients            | 34      |
| Events             | 37      |
| Forms              | 38      |
| Pricing            | 19      |
| Access             | 51      |
| Registrations      | 53      |
| Sponsorships       | 64      |
| Email (3 services) | 113     |
| Auth Middleware    | 36      |
| **Total**          | **481** |

### Running Tests

```bash
# Watch mode (development)
bun run test

# Single run (CI)
bun run test:run

# With coverage report
bun run test:coverage
```

### Writing Tests

```typescript
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { mockAuthenticatedUser } from "../../../tests/helpers/auth-helpers.js";
import { createMockClient } from "../../../tests/helpers/factories.js";

describe("MyService", () => {
  it("should do something", async () => {
    const mockClient = createMockClient();
    prismaMock.client.findUnique.mockResolvedValue(mockClient);

    const result = await myService.getClient(mockClient.id);

    expect(result).toEqual(mockClient);
  });
});
```

# Spec: Bedrock Alignment — Verify, DRY, Conceptual Integrity

## Context

After the full bedrock audit (10 modules, 689 tests, 149→31 barrel exports), three gaps remain:

1. **"Unverified = Unfinished"** — Zero integration tests. All 689 tests mock Prisma. Route→service wiring is never verified.
2. **DRY after 43rd use** — The `findUnique → null check → throw AppError` pattern repeats 43 times across 10 files. Bedrock says extract after 3rd use.
3. **Batch hardening** — Already has `.max(100)` on arrays, global rate limits, public endpoint rate limits. No action needed (YAGNI — no evidence of load issues).

This plan addresses #1 and #2. #3 is deferred per Via Negativa.

## Architecture Decisions

- **findOrThrow uses a lambda pattern** — `findOrThrow(() => tx.model.findUnique({...}), opts)`. The lambda captures `tx` context via closure, handling all variations (findUnique/findFirst, prisma/tx) with zero overloads.
- **Integration tests use existing infrastructure** — `createTestApp()` + `app.inject()` already exist and work (proven by `health.test.ts` and `email-webhook.routes.test.ts`). No new test infra needed.
- **Migrate findOrThrow only in high-repetition files** — `registrations.service.ts` (6+), `pricing.service.ts` (5+), `sponsorships-linking.service.ts` (4+). Single-occurrence files migrate organically when touched next.
- **Auth integration tests use `GET /api/users/me`** as the probe route — lightweight, requires auth, minimal service mocking. Must call `clearUserCache()` in `beforeEach` (60s SimpleCache in auth middleware).

## File Manifest

| File                                                       | Action | Task | Purpose                                   |
| ---------------------------------------------------------- | ------ | ---- | ----------------------------------------- |
| `src/shared/utils/db.ts`                                   | create | 1    | `findOrThrow` helper                      |
| `src/modules/registrations/registrations.service.ts`       | modify | 2    | Migrate 6 find-or-throw occurrences       |
| `src/modules/pricing/pricing.service.ts`                   | modify | 2    | Migrate 5 find-or-throw occurrences       |
| `src/modules/sponsorships/sponsorships-linking.service.ts` | modify | 2    | Migrate 4 find-or-throw occurrences       |
| `tests/integration/auth-wiring.test.ts`                    | create | 3    | Auth middleware integration tests         |
| `tests/integration/registration-public.test.ts`            | create | 4    | Registration submission integration tests |
| `tests/integration/sponsorship-public.test.ts`             | create | 5    | Sponsorship batch integration tests       |

## Cross-Task Contracts

### Task 1 → Task 2

```typescript
// src/shared/utils/db.ts
import { AppError } from "@shared/errors/app-error.js";
import type { ErrorCode } from "@shared/errors/error-codes.js";

export async function findOrThrow<T>(
  query: () => Promise<T | null>,
  options: { message: string; code: ErrorCode; statusCode?: number },
): Promise<T>;
```

Tasks 3-5 are independent — no contracts between them or with Tasks 1-2.

## Implementation Tasks

### Task 1: Create `findOrThrow` helper

**Files**: `src/shared/utils/db.ts`
**What**: DRY extraction of the 43x repeated find-null-throw pattern.
**Contracts produced**: `findOrThrow` function (see Cross-Task Contracts)
**How**:

- Create `src/shared/utils/db.ts` with the `findOrThrow` function
- Lambda-based design: `query: () => Promise<T | null>` — caller passes `() => prisma.model.findUnique(...)` or `() => tx.model.findFirst(...)`
- Default `statusCode` to 404
- Check for both `null` and `undefined`
- No unit test file — function is trivially correct (2 branches). Coverage comes from migrated service tests.

**Acceptance criteria**:

- [ ] `findOrThrow` exported from `src/shared/utils/db.ts`
- [ ] `bun run type-check` passes

### Task 2: Migrate high-repetition files to `findOrThrow`

**Files**: `registrations.service.ts`, `pricing.service.ts`, `sponsorships-linking.service.ts`
**What**: Replace inline find-null-throw blocks with `findOrThrow` in files with 4+ occurrences.
**Contracts consumed**: `findOrThrow` from Task 1
**How**:

- Read each file, identify all `const x = await ...; if (!x) throw new AppError(...)` blocks
- Replace with `const x = await findOrThrow(() => ..., { message, code })`
- Preserve exact error messages and error codes (no standardization — messages are already consistent)
- Skip occurrences that don't fit the pattern (e.g., `findUnique` that returns a subset via `select`, or null checks that aren't 404s)
- Run existing tests after each file migration

**Migration targets**:

- `registrations.service.ts`: ~6 occurrences (form lookup, registration lookups in update/delete/edit/upload)
- `pricing.service.ts`: ~5 occurrences (eventPricing lookups in get/update/delete + rule lookup)
- `sponsorships-linking.service.ts`: ~4 occurrences (sponsorship + registration lookups in link/unlink)

**Acceptance criteria**:

- [ ] All targeted occurrences replaced (no inline find-null-throw remaining in these 3 files for 404 cases)
- [ ] All 689+ existing tests still pass
- [ ] `bun run type-check` clean

### Task 3: Integration test — auth middleware wiring

**Files**: `tests/integration/auth-wiring.test.ts`
**What**: Verify the auth middleware pipeline works end-to-end via `app.inject()`.
**How**:

- Use `createTestApp()` from `tests/helpers/test-app.ts`
- Import `clearUserCache` from `@shared/middleware/auth.middleware.js` — call in `beforeEach` to prevent 60s cache interference
- Use `mockAuthenticatedUser()`, `mockUnauthenticated()`, `mockInactiveUser()`, `mockUserNotFound()` from `tests/helpers/auth-helpers.ts`
- Probe route: `GET /api/users/me` (requires auth, minimal mocking)
- Mock `prismaMock.user.findMany` for the `GET /api/users` super-admin-only route (role check)

**Test cases** (6):

1. Missing Authorization header → 401
2. Invalid/expired token (Firebase rejects) → 401
3. Valid token, user not in database → 401
4. Valid token, inactive user → 401
5. Valid token, super admin → 200
6. Client admin on super-admin-only route → 403

**Acceptance criteria**:

- [ ] 6 test cases all pass
- [ ] Each test asserts status code and error response shape
- [ ] `clearUserCache()` called in `beforeEach`

### Task 4: Integration test — registration submission

**Files**: `tests/integration/registration-public.test.ts`
**What**: Verify public registration route wiring (no auth required).
**How**:

- Use `createTestApp()`, route: `POST /api/public/forms/:formId/register`
- Mock chain: `prismaMock.form.findUnique` (form), `prismaMock.event.findUnique` (event), `prismaMock.$transaction` (already global), `prismaMock.registration.findUnique` (idempotency check)
- Mock `calculatePrice` via `vi.mock("@pricing")` — return a fixed price breakdown
- Mock `getFormById` and `getEventById` via their barrel mocks or prismaMock
- Follow existing pattern from `email-webhook.routes.test.ts`

**Test cases** (5):

1. Happy path: valid form + open event → 201 + response shape
2. Form not found → 404
3. Invalid body (missing required fields) → 400 (Zod validation)
4. Event not open → 400
5. Idempotency: same idempotency key → returns existing registration

**Acceptance criteria**:

- [ ] 5 test cases all pass
- [ ] Tests verify response body shape, not just status codes

### Task 5: Integration test — sponsorship batch submission

**Files**: `tests/integration/sponsorship-public.test.ts`
**What**: Verify public sponsorship batch route wiring (no auth required).
**How**:

- Use `createTestApp()`, route: `POST /api/public/events/:eventId/sponsorships`
- Mock `getEventById` via `prismaMock.event.findUnique`
- Mock `getSponsorFormForEvent` — check how sponsorships.public.routes.ts resolves the form (may use `prismaMock.form.findFirst`)
- Mock `createSponsorshipBatch` result via `prismaMock.$transaction`
- Follow pattern from Task 4

**Test cases** (5):

1. Happy path (CODE mode): valid event + form → 201 + batchId + count
2. Event not found → 404
3. Event not open → 400
4. Invalid body (empty beneficiaries) → 400
5. Sponsor form not found → 404

**Acceptance criteria**:

- [ ] 5 test cases all pass
- [ ] Tests verify response includes `batchId` and `count`

## Contract Graph

```
Task 1 (findOrThrow) ──produces──→ db.ts helper ──consumed by──→ Task 2
Task 2 (migration)   ──independent of──→ Tasks 3, 4, 5
Tasks 3, 4, 5        ──fully independent──→ can run in parallel
```

## Testing Strategy

- Task 1: `bun run type-check` only (no runtime test needed for trivial function)
- Task 2: `bun run test` full suite (migration must not break existing tests)
- Tasks 3-5: Run individually, then `bun run test` full suite
- Final: `bun run type-check && bun run test` must both pass clean

## Risks

- **Auth cache in integration tests**: The 60s `SimpleCache` in auth middleware can leak state between tests. Mitigated by `clearUserCache()` in `beforeEach`.
- **Module-level mocks in integration tests**: `vi.mock("@pricing")` must be hoisted above imports. Vitest handles this, but order matters.
- **findOrThrow migration: subtle pattern differences**: Some null checks are intentionally not 404 (e.g., "Registration not found after update" is 500). The engineer must read each occurrence and skip non-404 cases.
- **createTestApp() cost**: Building the full Fastify app per describe block is heavy. Use `beforeAll`/`afterAll` (not `beforeEach`) to share the app instance across tests in each file.

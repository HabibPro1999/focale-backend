# Spec: System Review Fixes (5 Priority Items)

## Requirement

Fix 5 issues identified by the system review team, in priority order:

1. Fix unbounded `exportRegistrations` query (memory bomb risk)
2. Enable 12 skipped webhook tests (zero coverage on public endpoint)
3. Fix missing ESLint boundary rules for sponsorships/pricing + barrel violation
4. Add simple failure notification via webhook (Slack/Discord compatible)
5. Extract duplicated condition evaluation logic into shared utility

## Research Summary

- `exportRegistrations()` at `reports.service.ts:357-460` uses `findMany()` with no `take` limit. Entire dataset JSON.stringify'd into response body. Route at `reports.routes.ts:70-89` sends it directly.
- `email-webhook.routes.test.ts:36-40` has `describe.skip` — comment says "require proper Fastify app setup with custom content-type parsers." The webhook route overrides `application/json` parser in its encapsulated scope.
- `eslint.config.js:27-65` has boundary rules for 8 modules but missing `sponsorships` and `pricing`. `pricing.service.ts:5` imports directly from `@modules/sponsorships/sponsorships.utils.js`. The barrel at `sponsorships/index.ts:35` already exports `calculateApplicableAmount`.
- No alerting infrastructure exists. Failures logged to Pino only. No HTTP client beyond `@sendgrid/mail`. Native `fetch()` available via Bun.
- Condition evaluation duplicated: `pricing.service.ts:298-434` and `form-data-validator.ts:78-214`. Key difference: pricing returns `false` on unknown operator, validator returns `true`. Validator version takes `allFields` parameter.

## Architecture Decisions

- **Bounded export (not streaming)** — Add `take` limit (max 10k, default 5k) to `findMany`. Streaming introduces a pattern absent from the codebase and is unnecessary at ~1 event/month scale.
- **Standalone Fastify instance for webhook tests (not parser mocking)** — Create a minimal Fastify instance that only registers the webhook plugin. Tests real parser behavior instead of fragile mocks of Fastify internals.
- **Shared utility for alerting (not dedicated module)** — Single file at `src/shared/utils/alerter.ts`. Matches `logger.ts` pattern. A full notification module is premature abstraction.
- **Configurable `unknownOperatorDefault` for condition evaluator** — Preserves exact current behavior for both callers (pricing: `false`, validator: `true`) with zero behavior change risk.

## File Manifest

| File                                             | Action | Task | Purpose                                                       |
| ------------------------------------------------ | ------ | ---- | ------------------------------------------------------------- |
| `src/modules/reports/reports.schema.ts`          | modify | 1    | Add `limit` field to ExportQuerySchema                        |
| `src/modules/reports/reports.service.ts`         | modify | 1    | Add `take` limit and parallel `count()`                       |
| `src/modules/reports/reports.routes.ts`          | modify | 1    | Add truncation headers to response                            |
| `src/modules/email/email-webhook.routes.test.ts` | modify | 2    | Remove `describe.skip`, add standalone app setup              |
| `eslint.config.js`                               | modify | 3    | Add boundary rules for sponsorships and pricing               |
| `src/modules/pricing/pricing.service.ts`         | modify | 3, 5 | Fix barrel import (task 3), remove condition helpers (task 5) |
| `src/config/app.config.ts`                       | modify | 4    | Add `ALERT_WEBHOOK_URL` env var                               |
| `src/shared/utils/alerter.ts`                    | create | 4    | Webhook alert utility                                         |
| `src/shared/utils/alerter.test.ts`               | create | 4    | Alert utility tests                                           |
| `src/index.ts`                                   | modify | 4    | Add alerts in email queue error + unhandledRejection          |
| `src/shared/middleware/error.middleware.ts`      | modify | 4    | Add alert for 500 errors                                      |
| `src/shared/utils/condition-evaluator.ts`        | create | 5    | Shared condition evaluation utility                           |
| `src/shared/utils/condition-evaluator.test.ts`   | create | 5    | Condition evaluator tests                                     |
| `src/shared/utils/form-data-validator.ts`        | modify | 5    | Remove duplicated helpers, import from shared                 |
| `src/shared/utils/form-data-validator.test.ts`   | modify | 5    | Move condition tests to new file                              |

## Cross-Task Contracts

### Task 5 -> Task 3 (pricing.service.ts)

Task 5 creates `src/shared/utils/condition-evaluator.ts` exporting:

```typescript
export interface EvaluableCondition {
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
}

export interface EvaluateConditionsOptions {
  unknownOperatorDefault?: boolean; // default: false
}

export function evaluateSingleCondition(
  condition: EvaluableCondition,
  formData: Record<string, unknown>,
  options?: EvaluateConditionsOptions,
): boolean;

export function evaluateConditions(
  conditions: EvaluableCondition[],
  logic: "AND" | "OR" | "and" | "or",
  formData: Record<string, unknown>,
  options?: EvaluateConditionsOptions,
): boolean;

export function isEqual(fieldValue: unknown, conditionValue: string): boolean;
export function containsValue(
  fieldValue: unknown,
  conditionValue: string,
): boolean;
export function isEmpty(fieldValue: unknown): boolean;
export function isGreaterThan(
  fieldValue: unknown,
  conditionValue: string,
): boolean;
export function isLessThan(
  fieldValue: unknown,
  conditionValue: string,
): boolean;
```

Task 3 modifies `pricing.service.ts` to import from `@shared/utils/condition-evaluator.js` and pass `{ unknownOperatorDefault: false }`.

### Task 4 -> Error middleware & index.ts

Task 4 creates `src/shared/utils/alerter.ts` exporting:

```typescript
export interface AlertPayload {
  title: string;
  message: string;
  severity: "info" | "warning" | "error" | "critical";
  context?: Record<string, unknown>;
}

export function sendAlert(payload: AlertPayload): void;
```

Consumers call `sendAlert()` fire-and-forget. Never throws.

## Implementation Tasks

### Task 1: Bound the export query

**Files**: `src/modules/reports/reports.schema.ts`, `src/modules/reports/reports.service.ts`, `src/modules/reports/reports.routes.ts`
**What**: Add a configurable limit (default 5000, max 10000) to `exportRegistrations` query to prevent memory exhaustion.
**Contracts consumed**: none
**Contracts produced**: none
**How**:

- Add `limit: z.coerce.number().int().min(1).max(10_000).default(5_000)` to `ExportQuerySchema` in `reports.schema.ts`
- In `exportRegistrations()` at `reports.service.ts:357`, add `take: query.limit` to the `findMany` call
- Run a parallel `prisma.registration.count({ where })` to get total count
- Return `metadata: { total, exported: registrations.length, truncated: registrations.length < total }` alongside `filename`, `contentType`, `data`
- In `reports.routes.ts:70-89`, add `X-Export-Total` and `X-Export-Truncated` response headers from metadata before sending
  **Acceptance criteria**:
- [ ] `findMany` has a `take` parameter, never unbounded
- [ ] Response includes truncation metadata headers
- [ ] Default limit is 5000, max is 10000
- [ ] Type check passes

### Task 2: Enable webhook tests

**Files**: `src/modules/email/email-webhook.routes.test.ts`
**What**: Remove `describe.skip`, create a standalone Fastify instance with the webhook plugin registered directly.
**Contracts consumed**: none
**Contracts produced**: none
**How**:

- Create a `createWebhookTestApp()` helper inside the test file that builds a minimal Fastify instance with ZodTypeProvider, registers error handler, and registers only `emailWebhookRoutes` with prefix `/api/webhooks/email`
- Replace `describe.skip` with `describe`
- Replace any `buildServer()` usage with `createWebhookTestApp()`
- Remove any `it.skip` on individual tests
- Ensure mocks for `verifyWebhookSignature`, `parseWebhookEvents`, `updateEmailStatusFromWebhook` are properly set up via `vi.mock()`
- Run the test file in isolation to confirm all 12 tests pass
  **Acceptance criteria**:
- [ ] No `describe.skip` or `it.skip` remain
- [ ] All 12 tests pass
- [ ] Tests use standalone Fastify instance, not `buildServer()`

### Task 3: Fix ESLint boundaries + barrel violation

**Files**: `eslint.config.js`, `src/modules/pricing/pricing.service.ts`
**What**: Add missing ESLint boundary rules for sponsorships and pricing modules. Fix the barrel import violation.
**Contracts consumed**: Task 5's condition evaluator (for the pricing.service.ts refactor — can be done in same pass)
**Contracts produced**: none
**How**:

- In `eslint.config.js`, add two new pattern objects to `no-restricted-imports` patterns array, following the exact pattern of existing rules:
  ```javascript
  { group: ["**/modules/sponsorships/**", "!**/modules/sponsorships/index.js"], message: "Import from @sponsorships barrel" },
  { group: ["**/modules/pricing/**", "!**/modules/pricing/index.js"], message: "Import from @pricing barrel" },
  ```
- In `pricing.service.ts:5`, change `import { calculateApplicableAmount } from "@modules/sponsorships/sponsorships.utils.js"` to `import { calculateApplicableAmount } from "@sponsorships"`
- Run `bun run lint` to verify no new violations
  **Acceptance criteria**:
- [ ] ESLint config has boundary rules for all 10 modules
- [ ] `pricing.service.ts` imports from `@sponsorships` barrel
- [ ] `bun run lint` passes with zero errors

### Task 4: Add failure alerting webhook

**Files**: `src/config/app.config.ts`, `src/shared/utils/alerter.ts` (create), `src/shared/utils/alerter.test.ts` (create), `src/index.ts`, `src/shared/middleware/error.middleware.ts`
**What**: Add a fire-and-forget webhook alert utility for critical failures, compatible with Slack/Discord incoming webhooks.
**Contracts consumed**: none
**Contracts produced**: `sendAlert(payload: AlertPayload): void` from `alerter.ts`
**How**:

- Add `ALERT_WEBHOOK_URL: z.string().url().optional()` to `envSchema` in `app.config.ts`, and `alertWebhookUrl: env.ALERT_WEBHOOK_URL` to the exported config
- Create `src/shared/utils/alerter.ts`:
  - `sendAlert()`: reads URL from config, no-op if not set, uses native `fetch()` with `AbortSignal.timeout(5000)`, wraps in try/catch, logs failures via `logger.warn()`, never throws
  - `formatWebhookBody()`: formats as `{ text: string }` body compatible with Slack/Discord webhooks. Include severity emoji, timestamp, structured context
  - Severity emoji mapping: info=`[INFO]`, warning=`[WARNING]`, error=`[ERROR]`, critical=`[CRITICAL]`
- Create `src/shared/utils/alerter.test.ts`: test no-op when URL not set, successful send, fetch failure handling, payload formatting. Mock `fetch` via `vi.spyOn(globalThis, 'fetch')`
- In `src/index.ts:49`, add `sendAlert({ title: "Email Queue Error", message: err.message, severity: "error" })` in the `.catch` handler
- In `src/index.ts:9`, add `sendAlert({ title: "Unhandled Rejection", message: String(reason), severity: "critical" })` in the unhandledRejection handler
- In `error.middleware.ts`, add `sendAlert()` for 500-level errors before sending the response
  **Acceptance criteria**:
- [ ] `sendAlert()` is no-op when `ALERT_WEBHOOK_URL` not configured
- [ ] `sendAlert()` never throws, never blocks caller
- [ ] Webhook body is valid Slack/Discord incoming webhook format
- [ ] Alerts fire for: email queue errors, unhandled rejections, 500 errors
- [ ] All alerter tests pass

### Task 5: Extract condition evaluator

**Files**: `src/shared/utils/condition-evaluator.ts` (create), `src/shared/utils/condition-evaluator.test.ts` (create), `src/modules/pricing/pricing.service.ts`, `src/shared/utils/form-data-validator.ts`, `src/shared/utils/form-data-validator.test.ts`
**What**: Extract duplicated condition evaluation logic into a shared utility with configurable defaults.
**Contracts consumed**: none
**Contracts produced**: `evaluateConditions()`, `evaluateSingleCondition()`, `EvaluableCondition`, `EvaluateConditionsOptions` from `condition-evaluator.ts`
**How**:

- Create `src/shared/utils/condition-evaluator.ts` with all helper functions (`isEqual`, `containsValue`, `isEmpty`, `isGreaterThan`, `isLessThan`), `evaluateSingleCondition()`, and `evaluateConditions()`. Add `EvaluableCondition` interface and `EvaluateConditionsOptions` with `unknownOperatorDefault` (default: `false`). Keep the comment referencing `pure-form/src/lib/conditions.ts`.
- Create `src/shared/utils/condition-evaluator.test.ts` with comprehensive tests for all operators, AND/OR logic, both `unknownOperatorDefault` values
- In `pricing.service.ts`: remove lines 298-434 (all condition helpers). Import `evaluateConditions` and `EvaluableCondition` from `@shared/utils/condition-evaluator.js`. Update call at ~line 240 to pass `{ unknownOperatorDefault: false }`
- In `form-data-validator.ts`: remove lines 78-214 (all condition helpers). Import `evaluateSingleCondition` from `@shared/utils/condition-evaluator.js`. Create local wrapper `evaluateFieldCondition()` that checks field existence in `allFields` (return `true` if not found) then delegates with `{ unknownOperatorDefault: true }`
- Update `form-data-validator.test.ts`: remove condition operator unit tests (now in `condition-evaluator.test.ts`), keep `shouldValidateField` integration tests
  **Acceptance criteria**:
- [ ] No condition evaluation helper functions remain in `pricing.service.ts` or `form-data-validator.ts`
- [ ] Pricing behavior unchanged: unknown operators return `false`
- [ ] Validator behavior unchanged: unknown operators return `true`, missing fields return `true`
- [ ] All existing tests pass
- [ ] New condition-evaluator tests cover all operators + both defaults

## Contract Graph

```
Task 5 ──produces──> condition-evaluator.ts ──consumed by──> Task 3 (pricing.service.ts refactor)
Task 5 ──produces──> condition-evaluator.ts ──consumed by──> form-data-validator.ts (same task)
Task 4 ──produces──> alerter.ts ──consumed by──> error.middleware.ts, index.ts (same task)
Tasks 1, 2 ──────> independent, no cross-task contracts
```

Execution order: Task 5 first (Task 3 depends on it for pricing.service.ts changes), then Tasks 1, 2, 3, 4 in parallel.

## Testing Strategy

- Run `bun run test:run` after all changes — all 541+ tests must pass
- Run `bun run lint` — zero errors/warnings
- Run `bun run type-check` — zero errors
- The 12 previously-skipped webhook tests should now pass (net +12 passing tests)
- New test files: `condition-evaluator.test.ts`, `alerter.test.ts`

## Risks

- **Webhook test flakiness**: The standalone Fastify instance approach should work but depends on the webhook route not requiring other plugins. The route is encapsulated, so this is low risk.
- **Condition evaluator behavior drift**: Both callers now share code. If one needs a new operator, it benefits both — but if one needs divergent behavior, the options pattern handles it via `EvaluateConditionsOptions`.
- **Alert webhook noise**: 500 errors in dev could generate many alerts. Mitigate: only send when `ALERT_WEBHOOK_URL` is configured, which is an intentional opt-in.
- **Export truncation UX**: Users with >10k registrations won't get a complete export in one request. Mitigate: date filtering already exists; 10k is generous for current scale.

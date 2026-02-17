# Spec: Remaining Gaps — Tests, DRY, Complexity

## Requirement

Complete the remaining gaps identified during the full bedrock audit:

1. **Test coverage** for 5 untested areas (email renderer, email SendGrid, reports, sponsorships LINKED_ACCOUNT batch, sponsorships stats)
2. **DRY extraction** of `EventIdParamSchema` (5 duplicates), `RegistrationIdParamSchema` (2), `FormIdParamSchema` (3)
3. **Complexity reduction** by splitting `sponsorships.service.ts` (1,878 lines) into 3 focused files

All agents must load /bedrock.

## Research Summary

- **Test infrastructure**: Vitest, `tests/mocks/prisma.ts` (deep mock + $transaction), `tests/mocks/sendgrid.ts`, `tests/helpers/factories.ts` (factories for all entities)
- **Test patterns**: `describe > describe > it`, `prismaMock.model.method.mockResolvedValue()`, `expect().rejects.toMatchObject({ statusCode, code })`, `vi.mock()` for module-level mocks
- **EventIdParamSchema**: 5 modules use `{ eventId: z.string().uuid() }` identically. Events module uses `{ id }` (different, stays local). No `src/shared/schemas/` directory exists yet.
- **Sponsorships service**: 1,878 lines. `createSponsorshipBatch` (529 lines, two modes), linking functions (~500 lines), CRUD + list + stats (~800 lines). Email module already demonstrates multi-file split pattern.

## Architecture Decisions

- **Test scope**: Unit tests with mocked dependencies (matches codebase). Email renderer gets 2-3 real MJML smoke tests since `compileMjmlToHtml` is a thin wrapper only testable with real MJML.
- **Shared params**: Extract to `src/shared/schemas/params.ts`. Bedrock DRY triggers at 3rd use. Events module's `{ id }` variant stays local (semantically different).
- **Sponsorships split**: 3 files — `sponsorships.service.ts` (CRUD/list/stats), `sponsorships-batch.service.ts` (batch creation), `sponsorships-linking.service.ts` (link/unlink/available). Precedent: email module has 5 service files.
- **Priority**: Tests for non-refactored modules first (email, reports), then structural changes (DRY, split), then new sponsorship tests against final structure.

## File Manifest

| File                                                            | Action | Task | Purpose                                                |
| --------------------------------------------------------------- | ------ | ---- | ------------------------------------------------------ |
| `src/modules/email/email-renderer.service.test.ts`              | create | 1    | Unit tests for Tiptap→MJML rendering                   |
| `src/modules/email/email-sendgrid.service.test.ts`              | create | 2    | Unit tests for SendGrid integration                    |
| `src/modules/reports/reports.service.test.ts`                   | create | 3    | Unit tests for financial reports + CSV                 |
| `src/shared/schemas/params.ts`                                  | create | 4    | Shared param schemas (EventId, RegistrationId, FormId) |
| `src/modules/access/access.schema.ts`                           | modify | 4    | Import EventIdParamSchema from shared                  |
| `src/modules/email/email.schema.ts`                             | modify | 4    | Import EventIdParamSchema from shared                  |
| `src/modules/pricing/pricing.schema.ts`                         | modify | 4    | Import EventIdParamSchema from shared                  |
| `src/modules/pricing/pricing.routes.ts`                         | modify | 4    | Import FormIdParamSchema from shared                   |
| `src/modules/registrations/registrations.schema.ts`             | modify | 4    | Import EventId, RegistrationId, FormId from shared     |
| `src/modules/sponsorships/sponsorships.schema.ts`               | modify | 4    | Import EventId, RegistrationId from shared             |
| `src/modules/forms/forms.schema.ts`                             | modify | 4    | Import FormIdParamSchema from shared                   |
| `src/modules/sponsorships/sponsorships-batch.service.ts`        | create | 5    | Extracted batch creation (createSponsorshipBatch)      |
| `src/modules/sponsorships/sponsorships-linking.service.ts`      | create | 5    | Extracted linking functions                            |
| `src/modules/sponsorships/sponsorships.service.ts`              | modify | 5    | Remove moved functions, retain CRUD/list/stats         |
| `src/modules/sponsorships/index.ts`                             | modify | 5    | Update barrel for new files                            |
| `src/modules/sponsorships/sponsorships.routes.ts`               | modify | 5    | Update import paths                                    |
| `src/modules/sponsorships/sponsorships.public.routes.ts`        | modify | 5    | Update import paths                                    |
| `src/modules/sponsorships/sponsorships.service.test.ts`         | modify | 5    | Move linking/batch tests to new files                  |
| `src/modules/sponsorships/sponsorships-batch.service.test.ts`   | create | 6    | Tests for LINKED_ACCOUNT batch mode                    |
| `src/modules/sponsorships/sponsorships-linking.service.test.ts` | create | 5    | Moved linking tests from original file                 |
| `src/modules/sponsorships/sponsorships-stats.test.ts`           | create | 6    | Tests for getSponsorshipStats                          |

## Cross-Task Contracts

### Task 4 → Tasks 1-3, 5-6

```typescript
// src/shared/schemas/params.ts
import { z } from "zod";

export const EventIdParamSchema = z
  .object({ eventId: z.string().uuid() })
  .strict();
export const RegistrationIdParamSchema = z
  .object({ registrationId: z.string().uuid() })
  .strict();
export const FormIdParamSchema = z.object({ id: z.string().uuid() }).strict();
```

Modules replace local definitions with imports from `@shared/schemas/params.js`.

### Task 5 → Task 6

Sponsorships split produces:

- `sponsorships-batch.service.ts` exports `createSponsorshipBatch`, `CreateBatchResult`
- `sponsorships-linking.service.ts` exports `linkSponsorshipToRegistration`, `linkSponsorshipByCode`, `unlinkSponsorshipFromRegistration`, `getAvailableSponsorships`, `getLinkedSponsorships`
- `sponsorships.service.ts` retains `AvailableSponsorship`, `LinkSponsorshipResult` types (imported via `import type` by sub-services)

## Contract Graph

```
Task 4 (shared schemas) ──produces──→ param schemas ──consumed by──→ Task 5 (imports in sponsorships.schema)
Task 5 (split)           ──produces──→ new file structure ──consumed by──→ Task 6 (new tests)
Tasks 1, 2, 3            ──independent──→ no dependencies
```

## Implementation Tasks

### Task 1: Email Renderer Tests

**Files**: `src/modules/email/email-renderer.service.test.ts`
**What**: Unit tests for Tiptap→MJML rendering, MJML compilation, CSS validation, XSS sanitization, plain text extraction.
**Contracts consumed**: none
**Contracts produced**: none
**How**:

- Load /bedrock skill. Read `src/modules/email/email-renderer.service.ts` fully before writing tests.
- Test `renderTemplateToMjml`: paragraph, heading (h1-h6), bulletList, orderedList, blockquote, horizontalRule, image, link-type mention as button, text alignment, empty paragraph spacer.
- Test `renderInlineNode`/`applyMarks`: bold, italic, underline, strike, code, link, textStyle. Test CSS validation via marks — valid colors pass, XSS attempts (`expression(...)`, `url(javascript:...)`) are stripped.
- Test `compileMjmlToHtml` with real MJML (not mocked) — valid MJML produces HTML string, malformed MJML throws.
- Test `extractPlainText`: paragraphs as text lines, headings with `#` prefix, lists with `- ` prefix, mentions as `{{variableName}}`.
- Test `sanitizeUrl` integration: `javascript:` URLs replaced with empty string, normal URLs pass through.
- Do NOT mock `sanitizeUrl`/`sanitizeForHtml` — they are pure functions, test them transitively.
- Follow pattern from `email-template.service.test.ts`.
  **Acceptance criteria**:
- [ ] All exported functions have at least one test
- [ ] CSS validation XSS vectors are tested (expression, javascript:, data:)
- [ ] Real MJML compilation smoke tests pass
- [ ] `bun run test src/modules/email/email-renderer.service.test.ts` passes

### Task 2: Email SendGrid Tests

**Files**: `src/modules/email/email-sendgrid.service.test.ts`
**What**: Unit tests for SendGrid email sending, webhook signature verification, event parsing.
**Contracts consumed**: none
**Contracts produced**: none
**How**:

- Load /bedrock skill. Read `src/modules/email/email-sendgrid.service.ts` fully before writing tests.
- Use existing mock from `tests/mocks/sendgrid.ts`. Create additional mock for `@sendgrid/eventwebhook`.
- Test `sendEmail`: successful send (202 response), missing API key (graceful no-op), SendGrid error (caught and returned), message construction (verify to/from/subject/html fields).
- Test `verifyWebhookSignature`: missing public key returns false, valid signature passes, invalid signature fails, exception handling.
- Test `parseWebhookEvents`: valid event array parsed correctly, non-array returns empty, customArgs extraction works.
- Mock `logger` to suppress output.
- Handle module-level env var reads: use `vi.stubEnv` or dynamic import.
  **Acceptance criteria**:
- [ ] `sendEmail` happy path and error path tested
- [ ] `verifyWebhookSignature` tested with valid/invalid/missing key
- [ ] `parseWebhookEvents` tested with valid/invalid input
- [ ] `bun run test src/modules/email/email-sendgrid.service.test.ts` passes

### Task 3: Reports Tests

**Files**: `src/modules/reports/reports.service.test.ts`
**What**: Unit tests for financial aggregation, CSV generation, formula injection defense.
**Contracts consumed**: none
**Contracts produced**: none
**How**:

- Load /bedrock skill. Read `src/modules/reports/reports.service.ts` fully before writing tests.
- Import `prismaMock` from `tests/mocks/prisma.js`.
- Test `getFinancialReport`: empty event (zero results), single currency, date range filtering.
- Test `exportRegistrations`: CSV format with headers, form field inclusion, JSON format option, limit metadata.
- Test CSV formula injection defense: strings starting with `=`, `+`, `-`, `@`, `\t`, `\r` get `'` prefix. Test CSV escaping of commas, quotes, newlines. Test null/undefined fields.
- Mock: `prisma.registration.groupBy`, `prisma.$queryRaw`, `prisma.form.findFirst`, `prisma.eventAccess.findMany`, `prisma.registration.findMany`, `prisma.registration.count`.
- Follow pattern from `clients.service.test.ts` for CRUD mock setup.
  **Acceptance criteria**:
- [ ] Financial aggregation tested with multi-currency grouping
- [ ] CSV formula injection defense tested for all dangerous prefixes
- [ ] CSV escaping tested (commas, quotes, newlines)
- [ ] `bun run test src/modules/reports/reports.service.test.ts` passes

### Task 4: Shared Param Schemas (DRY)

**Files**: `src/shared/schemas/params.ts` + 7 module schema/route files
**What**: Extract duplicated param schemas to shared location, update all modules to import from shared.
**Contracts consumed**: none
**Contracts produced**: shared param schemas (see Cross-Task Contracts)
**How**:

- Load /bedrock skill.
- Create `src/shared/schemas/params.ts` with `EventIdParamSchema` (`{ eventId }`), `RegistrationIdParamSchema` (`{ registrationId }`), `FormIdParamSchema` (`{ id }`).
- For each module: read the schema file, find the local definition, replace with import from `@shared/schemas/params.js`. Keep re-export if other files in the module import it from the schema file.
- Do NOT touch `events.schema.ts` — its `EventIdParamSchema` uses `{ id }` (different field name).
- Verify field names match before each replacement. `pricing.routes.ts` has an inline `FormIdParamSchema` — replace that too.
- Run `bun run type-check` and `bun run test` after.
  **Acceptance criteria**:
- [ ] `src/shared/schemas/params.ts` exists with 3 schemas
- [ ] No module (except events) defines its own `EventIdParamSchema`
- [ ] All existing tests pass
- [ ] `bun run type-check` clean

### Task 5: Sponsorships Service Split

**Files**: see File Manifest (8 files)
**What**: Split 1,878-line service into 3 focused files, update imports and tests.
**Contracts consumed**: shared param schemas (Task 4, for sponsorships.schema.ts update)
**Contracts produced**: new file structure (see Cross-Task Contracts)
**How**:

- Load /bedrock skill. Read `sponsorships.service.ts` fully.
- Create `sponsorships-batch.service.ts`: move `createSponsorshipBatch` + `CreateBatchResult` + `queueSponsorshipAppliedEmail` (if only used by batch). Copy all needed imports.
- Create `sponsorships-linking.service.ts`: move `linkSponsorshipToRegistration`, `linkSponsorshipByCode`, `unlinkSponsorshipFromRegistration`, `getAvailableSponsorships`, `getLinkedSponsorships`, `recalculateUsageAmounts`, `cleanupSponsorshipsForRegistration`. Move `AvailableSponsorship`, `LinkSponsorshipResult` types.
- Update `sponsorships.service.ts`: remove moved functions. Retain CRUD, list, stats, getSponsorshipClientId.
- Update barrel `index.ts`: export from all 3 service files.
- Update route imports: `sponsorships.routes.ts` and `sponsorships.public.routes.ts`.
- Split test file: move linking tests to `sponsorships-linking.service.test.ts`, batch tests to `sponsorships-batch.service.test.ts`.
- Run `bun run type-check` and `bun run test` after.
- Do NOT modify `tests/mocks/prisma.ts`.
  **Acceptance criteria**:
- [ ] `sponsorships.service.ts` is under 800 lines
- [ ] All 3 service files compile cleanly
- [ ] All existing sponsorship tests pass (just in new file locations)
- [ ] Barrel exports unchanged (same symbols, different source files)

### Task 6: New Sponsorship Tests

**Files**: `sponsorships-batch.service.test.ts` (add to), `sponsorships-stats.test.ts`
**What**: Tests for LINKED_ACCOUNT batch mode and getSponsorshipStats.
**Contracts consumed**: new file structure from Task 5
**Contracts produced**: none
**How**:

- Load /bedrock skill. Read the batch and stats service files.
- LINKED_ACCOUNT batch tests: successful linked creation (USED status, SponsorshipUsage records, registration.sponsorshipAmount updated), capping to zero (skipped), cumulative capping within batch, overlap detection warnings, duplicate registrationId validation, missing registration validation, email queueing success, email failure resilience.
- getSponsorshipStats tests: empty event (zeros, "TND" default), grouped results (PENDING/USED/CANCELLED counts and amounts), currency from pricing.
- Follow patterns from existing `sponsorships.service.test.ts`.
  **Acceptance criteria**:
- [ ] LINKED_ACCOUNT batch mode has at least 6 test cases
- [ ] getSponsorshipStats has at least 3 test cases
- [ ] `bun run test src/modules/sponsorships/` passes all tests

## Testing Strategy

- Tasks 1-3: New test files, run individually then full suite
- Task 4: Structural change — run full suite to verify no regressions
- Task 5: File split — run full suite to verify no regressions
- Task 6: New tests against split structure — run sponsorships tests then full suite
- Final: `bun run type-check && bun run test` must both pass clean

## Risks

- **Sponsorships split circular imports**: Batch and linking services may both need types from the main service. Mitigate: use `import type` (no runtime circular dependency). If needed, create `sponsorships.types.ts`.
- **SendGrid module-level env reads**: `email-sendgrid.service.ts` may read `process.env.SENDGRID_API_KEY` at import time. Mitigate: use `vi.stubEnv` before import, or dynamic `await import()` in tests.
- **Reports raw SQL mocking**: `$queryRaw` returns untyped results. Mitigate: mock returns matching the exact shape the service destructures. Tests verify aggregation logic, not SQL correctness.
- **Shared param field name mismatch**: Each module's param schema may use different field names. Mitigate: verify exact field name in each file before replacing. Events module (`{ id }`) is excluded.
- **Test file split may break test count**: Moving describe blocks between files. Mitigate: run test count before and after split, verify same total.

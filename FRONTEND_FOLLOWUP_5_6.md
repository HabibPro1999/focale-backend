# Frontend follow-up: 5.6 contract artifacts

No API, payload or error-code change. The backend now publishes generated
contract artifacts in `packages/contracts/generated/`: JSON Schema, TypeScript
types, and condition parity fixtures. README-rebuild.md, section "Frontend
contract artifacts", explains the files and how to consume them. The tasks below
are for the frontend repos, whenever they adopt the artifacts.

## Form repo

- Add a parity test for `src/lib/conditions.ts` (`evaluateConditions`, field
  visibility) driven by `fixtures/field-visibility.json`. The current code
  passes all 59 cases (checked against form `develop` ba6c271).
- Add a parity test for `src/lib/pricing-conditions.ts` (`evaluateConditions`,
  pricing preview) driven by `fixtures/rule-conditions.json`. The current code
  passes all 88 cases. The file is the same blob on `develop` ba6c271 and
  `origin/main`.
- The `pricing-conditions.ts` header still says it is a port of
  `backend/src/shared/utils/conditions.ts @ 5041fde`. The server file is now
  `packages/shared/src/conditions.ts`, where the functions are named
  `evaluateRuleConditions` / `evaluateRuleCondition`. The bodies are otherwise
  identical.
- Optional: replace hand-written request types with `types/contracts.input.ts`.

## Admin repo

- `src/features/registrations/utils/conditions.ts` (field visibility in the
  admin registration form and the form-builder preview) has drifted from the
  form app and the server. It fails 2 of the 59 `field-visibility` cases:
  - `not_contains` is not handled, so it falls to the default branch and the
    field is shown even when the text contains the value;
  - an unknown operator shows the field, while the form app and the server hide
    it.
  Adopt the fixture, then port the form app's evaluator (or the server's
  `packages/shared/src/field-visibility.ts`, which is byte-identical to it
  below its type declarations).
- `src/lib/condition-satisfiability.ts`: below its header, the file is
  byte-identical to the server's `packages/contracts/src/condition-satisfiability.ts`
  (checked at admin `develop` 50e99c7; the server copy was re-wrapped to match).
  The admin header still points at the legacy
  `backend/src/shared/utils/condition-satisfiability*.ts` paths. The spec is now
  `apps/api/src/modules/pricing/condition-satisfiability.test.ts`.
- Optional: use `types/contracts.input.ts` for request bodies (for example
  `CreateEventAccessBody`, `UpdateEventPricing`, `CreateForm`).

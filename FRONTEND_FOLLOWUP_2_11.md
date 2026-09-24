# Frontend follow-up: form visibility and one pricing input (2.11)

The server now hides, requires and stores form fields exactly as the public
form app does: `packages/shared/src/field-visibility.ts` is a byte-for-byte port
of `form/src/lib/conditions.ts` (identical on the form repo's `develop` and
`main`), quirks included. Quote, create and edit price the same cleaned data.
No new endpoints. One new field-error code.

## Public form (registration)

- **Fields the form hides are no longer required.** Before, the server used
  the strict pricing evaluator for visibility (case-sensitive, logic
  case-insensitive, conditions on missing fields ignored), so a field the form
  hid could still come back as a required-field error, and a field the form
  showed could be treated as hidden.
- **Visible answers are saved; hidden answers are dropped.** Create and
  self-edit store only the answers to fields the form shows (validated and
  coerced, e.g. trimmed text, numbers from numeric strings, a single checkbox
  value as an array). Values the form keeps in state for hidden fields are
  discarded, as before, but now by the form app's own rules.
- **Quote = charge.** `POST /api/public/forms/:formId/calculate-price` now
  prices the same cleaned data as create/edit. Before, the quote priced hidden
  and uncoerced answers, so it could differ from the stored price. The quote
  still returns 400 `FORM_VALIDATION_ERROR` when a required visible answer is
  missing.
- **New field-error code `invalid_condition`.** When a field's condition has a
  non-string value that the form app's evaluator calls `.toLowerCase()` on (see
  the evaluator bugs below), the form app throws while rendering; the server
  now answers 400 `FORM_VALIDATION_ERROR` with
  `fieldErrors[].code = "invalid_condition"` for that field instead of a 500.
  Run the report below to find such forms.

## Form app evaluator bugs to fix client-side (not fixed here)

These are now server behavior too, because the server copies the form app. Fix
them in the form app first, then port the change to `field-visibility.ts`:

- Uppercase `conditionLogic: "AND"` is treated as OR (`logic === 'and'` only
  matches lowercase). The admin builder and the contract allow `"AND"`/`"OR"`.
- `.toLowerCase()` throws on non-string condition values (numbers, booleans,
  missing values) in `equals`, `not_equals`, `contains`, `not_contains` once the
  referenced field has a text or checkbox answer; the form crashes.
- `FieldRenderer` passes `field.conditionLogic || "and"`, while `FormContext`
  and `validation.ts` pass `field.conditionLogic` (default only for
  `undefined`); they differ only for `""`/`null`, which the contract rejects.

Affected forms: run the read-only report (writes nothing, one READ ONLY
transaction) from `apps/api`:

```
node dist/scripts/form-condition-report.js
```

It lists fields with uppercase `conditionLogic` (and whether lowercasing would
change who sees the field — only `"AND"` with 2+ conditions does), non-string
condition values, unknown operators, and conditions on fields the form does not
have. Lowercasing a form's logic is a per-form decision, because it changes
what its registrants see.

## Admin

- **`FormPreview` should share the public form's visibility semantics.**
  `src/features/form-builder/components/FormPreview.tsx` has its own evaluator
  (case-sensitive `String(a) === String(b)`, no array handling), so the preview
  can show or hide different fields than the public form and the server.
- **Admin create/edit registration validate the answers.**
  `POST /api/events/:eventId/admin/registrations` and
  `PUT /api/events/:eventId/registrations/:id/admin-edit` now
  validate `formData` against the registration form without enforcing required
  fields: blank answers are accepted and kept as sent, other answers are
  type-checked (options must exist, emails/numbers/dates must be valid) and
  hidden-field answers are dropped before storing and pricing. Invalid answers
  → 400 `FORM_VALIDATION_ERROR` with `fieldErrors` (before: stored as sent).
  Show the field errors in the admin registration form; an old registration
  whose stored answer is no longer a valid option must be corrected when its
  form data is edited.
- An access-only admin edit keeps pricing the stored answers.

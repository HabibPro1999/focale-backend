# Frontend follow-up: canonical price breakdown (5.2b)

The admin and public registration responses now declare `priceBreakdown` as
the shared `PriceBreakdown`, also used by the public price quote. Valid
stored breakdowns keep their existing JSON shape and key order.

When adopting the generated contracts in the admin or form app:

- Treat `droppedAccessItems` as optional; use `droppedAccessItems ?? []`.
  Older registrations can omit it.
- Handle both dropped-item reasons: `capacity_reached` and `deactivated`.
- Dropped-item `name` is a string. Access lines, including dropped lines,
  may carry `status: "confirmed"` from public signup.
- Registration `priceBreakdown` is typed instead of `unknown`; use the
  canonical contract instead of a separate handwritten shape.

Undeclared nested breakdown fields are stripped from registration responses
in every environment, including while `JSONB_VALIDATION=warn`. Missing or
invalid declared fields also fail response diagnostics outside production.
No error code or endpoint changes.

Before deployment, the operator must run the read-only `stored-json-report`
with this version and review findings for `registrations.price_breakdown`.
Resolve unexpected shapes before clients rely on the typed responses. Keep
`JSONB_VALIDATION=warn` until the complete audit is clean; `enforce` refuses
invalid breakdowns at registration and settlement read boundaries.

The public form's existing restrictions on payment-method selection and
proof upload for `PARTIAL` registrations are unchanged. Whether partially
sponsored registrants should pay the balance there remains a product decision.

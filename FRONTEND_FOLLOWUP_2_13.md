# Frontend follow-up: registration cleanup (2.13)

Admin only. `GET /api/events/:eventId/registrations` → `stats`:

- **`pending.amount` is now the amount still due**: for PENDING, VERIFYING and
  PARTIAL registrations, the sum of each one's net minus what it has paid
  (at least 0). It used to be the sum of their gross totals, which counted
  sponsorships and partial payments as owed.
- **New `stats.collected`**: the sum of paid amounts across every status
  except REFUNDED (PAID, PARTIAL, VERIFYING, and any payment recorded on a
  sponsored or waived registration). Use it for "money collected";
  `paid.amount` stays the PAID-only sum.
- Unchanged: `total`, `totalAmount` (gross), `paid`, `sponsored`
  (`amount` = gross of SPONSORED and WAIVED).

Add `collected: number` to the admin `RegistrationStats` type
(`src/features/registrations/types.ts`).

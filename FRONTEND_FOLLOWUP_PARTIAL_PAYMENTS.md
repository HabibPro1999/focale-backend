# Frontend follow-up — public payment of a partial balance

The existing public payment page supports `PENDING` and `PARTIAL`. The backend
now accepts the corresponding actions for `PARTIAL` registrations:

| Endpoint | Before from PARTIAL | After |
|---|---|---|
| `PATCH /api/public/registrations/:id/payment-method` | 400 `REG_8004` | Accepts CASH or LAB_SPONSORSHIP under the existing module rules; preserves PARTIAL and all existing amounts |
| `POST /api/public/registrations/:id/payment-proof` | 400 `STT_12002` | Stores the proof privately and moves to VERIFYING; existing payment and sponsorship amounts stay unchanged |

- Keep the payment link available for PARTIAL and display only the remaining
  balance: gross minus sponsorship minus payments already confirmed, floored at
  zero. Choosing a method or submitting proof does not count as another payment.
- After a proof upload, reload the registration and show VERIFYING. Method
  selection is still refused from VERIFYING, PAID, SPONSORED, WAIVED and REFUNDED.
- A concurrent admin confirmation can still reject an upload with `STT_12002`
  or a method change with `REG_8004`; refresh to show the latest status.
- Sponsored seats stay reserved while proof is under review. Admin review can
  return the registration to PARTIAL or confirm PAID without counting those
  seats twice. The admin confirmed amount remains the cumulative paid amount.

No response shape, error code, migration or environment setting was added.
Frontend source was not changed. This implements the confirmed existing product
behavior; there is no outstanding product decision about access to this flow.

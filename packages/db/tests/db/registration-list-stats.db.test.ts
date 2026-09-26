import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateSettlement } from "@app/shared";
import { listRegistrationRows } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

type Amounts = {
  paymentStatus: "PENDING" | "PARTIAL" | "VERIFYING" | "PAID" | "SPONSORED" | "WAIVED" | "REFUNDED";
  totalAmount: number;
  sponsorshipAmount: number;
  paidAmount: number;
};

// Includes legacy shapes the settlement writer no longer produces (a
// sponsorship above gross, a payment above net) so the per-row floor matters.
const ROWS: Amounts[] = [
  { paymentStatus: "PENDING", totalAmount: 100, sponsorshipAmount: 0, paidAmount: 0 },
  { paymentStatus: "PENDING", totalAmount: 100, sponsorshipAmount: 150, paidAmount: 0 },
  { paymentStatus: "PARTIAL", totalAmount: 200, sponsorshipAmount: 50, paidAmount: 60 },
  { paymentStatus: "PARTIAL", totalAmount: 120, sponsorshipAmount: 0, paidAmount: 200 },
  { paymentStatus: "VERIFYING", totalAmount: 80, sponsorshipAmount: 0, paidAmount: 30 },
  { paymentStatus: "PAID", totalAmount: 90, sponsorshipAmount: 10, paidAmount: 80 },
  { paymentStatus: "SPONSORED", totalAmount: 70, sponsorshipAmount: 70, paidAmount: 0 },
  { paymentStatus: "REFUNDED", totalAmount: 60, sponsorshipAmount: 0, paidAmount: 60 },
];

describe.runIf(dbTestsEnabled())("registration list stats", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("sums each row's amount due with the shared settlement math, per payment status", async () => {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    await Promise.all(ROWS.map((row) => seedRegistration({ eventId: event.id, formId: form.id, ...row })));
    // Another event's registration never counts.
    const other = await seedEvent();
    await seedRegistration({
      eventId: other.id,
      formId: (await seedForm({ eventId: other.id })).id,
      paymentStatus: "PENDING",
      totalAmount: 999,
    });

    const { stats, total } = await listRegistrationRows(event.id, { page: 1, limit: 5 } as never);
    expect(total).toBe(ROWS.length);

    const expected = new Map<string, { cnt: number; totalAmount: number; paidAmount: number; amountDue: number }>();
    for (const row of ROWS) {
      const acc = expected.get(row.paymentStatus) ?? { cnt: 0, totalAmount: 0, paidAmount: 0, amountDue: 0 };
      acc.cnt += 1;
      acc.totalAmount += row.totalAmount;
      acc.paidAmount += row.paidAmount;
      acc.amountDue += calculateSettlement(row).amountDue;
      expected.set(row.paymentStatus, acc);
    }
    const byStatus = new Map(stats.map(({ paymentStatus, ...rest }) => [paymentStatus, rest]));
    expect(byStatus).toEqual(expected);
    // PENDING 100 + 0, PARTIAL 90 + 0, VERIFYING 50: the over-covered rows add nothing.
    expect(byStatus.get("PENDING")!.amountDue).toBe(100);
    expect(byStatus.get("PARTIAL")!.amountDue).toBe(90);
    expect(byStatus.get("VERIFYING")!.amountDue).toBe(50);
  });

  it("applies the list filters to the stats", async () => {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    await Promise.all(ROWS.map((row) => seedRegistration({ eventId: event.id, formId: form.id, ...row })));

    const { stats } = await listRegistrationRows(event.id, { page: 1, limit: 20, paymentStatus: "PARTIAL" } as never);
    expect(stats).toEqual([{ paymentStatus: "PARTIAL", cnt: 2, totalAmount: 320, paidAmount: 260, amountDue: 90 }]);
  });
});

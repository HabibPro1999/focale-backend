import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatformRegistrationAggregate } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("platform registration aggregate", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("counts across tenants and includes zero-valued statuses", async () => {
    const a = await seedEvent(); const b = await seedEvent();
    const fa = await seedForm({ eventId: a.id }); const fb = await seedForm({ eventId: b.id });
    await seedRegistration({ eventId: a.id, formId: fa.id, paymentStatus: "PAID" });
    await seedRegistration({ eventId: b.id, formId: fb.id, paymentStatus: "PENDING" });
    const result = await getPlatformRegistrationAggregate();
    expect(result.total).toBe(2);
    expect(result.byPaymentStatus).toEqual(expect.arrayContaining([
      { paymentStatus: "PAID", count: 1 }, { paymentStatus: "PENDING", count: 1 }, { paymentStatus: "REFUNDED", count: 0 },
    ]));
    expect(result.byPaymentStatus.reduce((n, row) => n + row.count, 0)).toBe(2);
  });
});

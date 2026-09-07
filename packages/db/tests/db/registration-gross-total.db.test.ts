import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, registrations } from "@app/db";
import { calculateSettlement } from "@app/shared";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";

const migration = readFileSync(new URL("../../migrations/0011_registration_gross_total.sql", import.meta.url), "utf8");
describe.runIf(dbTestsEnabled())("registration gross-total repair", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("repairs proven net totals once and preserves gross/manual totals", async () => {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    const rows = await Promise.all([
      { totalAmount: 60, sponsorshipAmount: 40 },
      { totalAmount: 100, sponsorshipAmount: 40 },
      { totalAmount: 80, sponsorshipAmount: 40 },
      { totalAmount: 60, sponsorshipAmount: 0 },
    ].map((amounts) => seedRegistration({ eventId: event.id, formId: form.id,
      ...amounts, priceBreakdown: { subtotal: 100, total: 60, sponsorshipTotal: 40 },
    })));
    await getDb().execute(sql.raw(migration));
    await getDb().execute(sql.raw(migration));
    const stored = new Map((await getDb().select().from(registrations)).map((r) => [r.id, r]));
    expect(rows.map((r) => stored.get(r.id)!.totalAmount)).toEqual([100, 100, 80, 60]);
    expect(calculateSettlement(stored.get(rows[0].id)!).amountDue).toBe(60);
  });
});

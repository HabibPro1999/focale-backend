import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdminCreateRegistrationSchema } from "@app/contracts";
import { getAccessCapacityInfo, getAccessRegisteredCount, getDb } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { seedEvent, seedEventAccess, seedForm } from "../../../../../packages/db/tests/helpers/factories";
import type { Config } from "../../core/config";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationCreateService } from "./registrations.create.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

// A prerequisite edit locks access rows that admin creation's counters also
// update. A deadlock/restart must retry the whole transaction, without leaving
// the first attempt's registration, counters or audit behind. Inject the SQLSTATE
// after real writes to exercise rollback deterministically on both engines.
describe.runIf(dbTestsEnabled())("admin registration transaction retries", () => {
  it.each(["40P01", "40001"])("retries %s after writes, committing exactly once", async (code) => {
    const event = await seedEvent({ endDate: new Date("2099-01-01T00:00:00Z") });
    await seedForm({ eventId: event.id, schema: { steps: [] } });
    const item = await seedEventAccess({ eventId: event.id, type: "ADDON", price: 100 });
    const access = new AccessService();
    const effects = new RegistrationSideEffects(access);
    const realAudit = effects.audit.bind(effects);
    const audit = vi.spyOn(effects, "audit").mockImplementationOnce(async (...args) => {
      await realAudit(...args);
      throw Object.assign(new Error("injected transaction conflict after audit"), { code });
    });
    const service = new RegistrationCreateService(
      access,
      new PricingService(),
      { publicLinkAllowedOrigins: [] } as unknown as Config,
      effects,
    );
    const actor = randomUUID();

    const created = await service.createAdminRegistration(event.id, AdminCreateRegistrationSchema.parse({
      email: `${randomUUID()}@example.test`,
      firstName: "Retry",
      lastName: "Registrant",
      formData: {},
      paymentStatus: "PAID",
      accessSelections: [{ accessId: item.id, quantity: 1 }],
      sendEmail: false,
    }), actor);

    expect(audit).toHaveBeenCalledTimes(2);
    const pool = getDb().$client;
    expect((await pool.query('SELECT id FROM registrations WHERE event_id = $1', [event.id])).rows)
      .toEqual([{ id: created.id }]);
    // CockroachDB's INT8 is returned as a string by pg; compare the numeric value.
    const counters = (await pool.query('SELECT registered_count AS count FROM events WHERE id = $1', [event.id])).rows;
    expect(counters).toHaveLength(1);
    expect(Number(counters[0].count)).toBe(1);
    expect(await getAccessCapacityInfo(item.id)).toMatchObject({ paidCount: 1 });
    expect(await getAccessRegisteredCount(item.id)).toEqual({ registeredCount: 1 });
    expect((await pool.query('SELECT entity_id AS "entityId" FROM audit_logs WHERE performed_by = $1', [actor])).rows)
      .toEqual([{ entityId: created.id }]);
  });
});

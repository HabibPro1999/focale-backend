import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  accessCheckIns,
  buildRegistrationWhere,
  getDb,
  getRegistrationFormDataKeys,
  iterateRegistrationsForExport,
  iterateRegistrationsForModularExport,
  paymentTransaction,
  registrations,
  type RegistrationFilters,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess, seedForm, seedRegistration } from "../helpers/factories";

// 3.7: registration exports page by keyset (submitted_at DESC, id DESC), one
// short statement per page, with the list's WHERE; the CSV/XLSX header comes
// from a DISTINCT jsonb_object_keys query. Both engines in CI.
describe.runIf(dbTestsEnabled())("db tier: registration export pages (3.7)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const base = Date.parse("2026-09-01T08:00:00.000Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  async function setup() {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    const other = await seedEvent();
    const otherForm = await seedForm({ eventId: other.id });
    const seed = (minutes: number, values: Partial<typeof registrations.$inferInsert> = {}) =>
      seedRegistration({ eventId: event.id, formId: form.id, submittedAt: at(minutes), ...values });

    // Three rows share one submitted_at, so page boundaries fall inside a tie.
    await seed(1, { paymentStatus: "PAID", formData: { city: "Tunis", zeta: 1 } });
    await seed(2, { formData: { city: "Sfax", alpha: { nested: true } } });
    await seed(2, { formData: [] });
    await seed(2, { firstName: "Mehdi", lastName: "Trabelsi", formData: "scalar" });
    await seed(3, { paymentStatus: "PAID", formData: { Beta: "x" } });
    await seed(4, { formData: {} });
    await seed(5, { paymentStatus: "PAID", formData: { city: "Nabeul" } });
    await seedRegistration({
      eventId: other.id,
      formId: otherForm.id,
      submittedAt: at(3),
      formData: { elsewhere: true },
    });
    return { event, form };
  }

  async function orderedIds(eventId: string, filters: RegistrationFilters = {}) {
    const rows = await getDb()
      .select({ id: registrations.id })
      .from(registrations)
      .where(buildRegistrationWhere(eventId, filters))
      .orderBy(desc(registrations.submittedAt), desc(registrations.id));
    return rows.map((row) => row.id);
  }

  async function drain<T>(pages: AsyncIterable<T[]>): Promise<T[][]> {
    const out: T[][] = [];
    for await (const page of pages) out.push(page);
    return out;
  }

  it("returns every row once, in export order, across page boundaries and ties", async () => {
    const { event } = await setup();

    for (const pageSize of [1, 2, 3, 7, 500]) {
      const pages = await drain(iterateRegistrationsForExport(event.id, {}, { pageSize }));
      const ids = pages.flat().map((row) => row.id);

      expect(ids, `pageSize ${pageSize}`).toEqual(await orderedIds(event.id));
      expect(new Set(ids).size).toBe(7);
      expect(pages.every((page) => page.length <= pageSize && page.length > 0)).toBe(true);
    }
  });

  it("applies the list's filters (status, search, submitted_at range)", async () => {
    const { event } = await setup();

    const paid = (await drain(iterateRegistrationsForExport(event.id, { paymentStatus: "PAID" }, { pageSize: 2 }))).flat();
    expect(paid.map((row) => row.id)).toEqual(await orderedIds(event.id, { paymentStatus: "PAID" }));
    expect(paid).toHaveLength(3);

    const searched = (await drain(iterateRegistrationsForExport(event.id, { search: "trabelsi mehdi" }))).flat();
    expect(searched.map((row) => row.firstName)).toEqual(["Mehdi"]);

    const range = { startDate: at(2).toISOString(), endDate: at(4).toISOString() };
    const ranged = (await drain(iterateRegistrationsForExport(event.id, range, { pageSize: 2 }))).flat();
    expect(ranged.map((row) => row.id)).toEqual(await orderedIds(event.id, range));
    expect(ranged).toHaveLength(5);
  });

  it("loads check-ins and transactions per page for the modular export", async () => {
    const { event, form } = await setup();
    const access = await seedEventAccess({ eventId: event.id });
    const first = await seedRegistration({ eventId: event.id, formId: form.id, submittedAt: at(10) });
    await getDb().insert(accessCheckIns).values({ registrationId: first.id, accessId: access.id, checkedInAt: at(20), checkedInBy: "door" });
    await getDb().insert(paymentTransaction).values([
      { registrationId: first.id, type: "PAYMENT", amount: 100, createdAt: at(11) },
      { registrationId: first.id, type: "REFUND", amount: -40, createdAt: at(12) },
    ]);

    const pages = await drain(
      iterateRegistrationsForModularExport(
        event.id,
        { needCheckIns: true, needTransactions: true },
        { pageSize: 3 },
      ),
    );
    const rows = pages.flat();

    expect(rows.map((row) => row.id)).toEqual(await orderedIds(event.id));
    expect(rows[0]).toMatchObject({
      id: first.id,
      accessTypeIds: [],
      droppedAccessIds: [],
      accessCheckIns: [{ accessId: access.id, checkedInAt: at(20) }],
      transactions: [
        expect.objectContaining({ type: "PAYMENT", amount: 100 }),
        expect.objectContaining({ type: "REFUND", amount: -40 }),
      ],
    });
    expect(rows.slice(1).every((row) => row.accessCheckIns!.length === 0 && row.transactions!.length === 0)).toBe(true);

    const bare = (await drain(iterateRegistrationsForModularExport(event.id, { needCheckIns: false, needTransactions: false }))).flat();
    expect(bare[0]!.accessCheckIns).toBeUndefined();
    expect(bare[0]!.transactions).toBeUndefined();
  });

  it("lists the filtered rows' form_data keys, sorted, skipping non-object form_data", async () => {
    const { event } = await setup();

    expect(await getRegistrationFormDataKeys(event.id, {})).toEqual(["Beta", "alpha", "city", "zeta"]);
    expect(await getRegistrationFormDataKeys(event.id, { paymentStatus: "PAID" })).toEqual([
      "Beta",
      "city",
      "zeta",
    ]);
    const none = await seedEvent();
    expect(await getRegistrationFormDataKeys(none.id, {})).toEqual([]);
  });

  it("stops before fetching once the signal is aborted", async () => {
    const { event } = await setup();
    const controller = new AbortController();
    const pages = iterateRegistrationsForExport(event.id, {}, { pageSize: 2, signal: controller.signal });

    const first = await pages.next();
    expect(first.value).toHaveLength(2);
    controller.abort(new Error("client left"));
    await expect(pages.next()).rejects.toThrow("client left");
  });

  it("keeps rows whose submitted_at equals the cursor but sort after it by id", async () => {
    const { event, form } = await setup();
    // Five more rows on one instant: only the id orders them.
    for (let i = 0; i < 5; i++) await seedRegistration({ eventId: event.id, formId: form.id, submittedAt: at(30) });
    const tied = await getDb()
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.submittedAt, at(30))));
    expect(tied).toHaveLength(5);

    const ids = (await drain(iterateRegistrationsForExport(event.id, {}, { pageSize: 2 }))).flat().map((row) => row.id);
    expect(ids).toEqual(await orderedIds(event.id));
    expect(ids).toHaveLength(12);
  });
});

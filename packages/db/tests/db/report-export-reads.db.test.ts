import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  abstractReviews,
  abstracts,
  accessCheckIns,
  getAbstractsExportPlan,
  getDb,
  getEventSummaryData,
  getReportEventAndAccess,
  getSponsorshipsReportData,
  iterateAbstractsForExport,
  iterateAccessRegistrantsForReport,
  iterateCheckInReportRows,
  iterateSponsorshipsForReport,
  registrations,
  sponsorships,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  linkAbstractTheme,
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedEvent,
  seedEventAccess,
  seedForm,
  seedRegistration,
  seedSponsorship,
  seedSponsorshipBatch,
  seedSponsorshipUsage,
  seedUser,
} from "../helpers/factories";

// 3.7b: the report and abstract exports read their small header data up front
// (SQL aggregates, sort keys, ids) and their rows page by page (keyset on
// registrations, id chunks otherwise). Both engines in CI.

const base = Date.parse("2026-09-01T08:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000);

async function drain<T>(pages: AsyncIterable<T[]>): Promise<T[][]> {
  const out: T[][] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const byKey = <T>(key: (row: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

describe.runIf(dbTestsEnabled())("db tier: report and abstract export reads (3.7b)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function registrationSetup() {
    const event = await seedEvent({ name: "Congrès" });
    const form = await seedForm({ eventId: event.id });
    const lunch = await seedEventAccess({ eventId: event.id, name: "Déjeuner", sortOrder: 2 });
    const workshop = await seedEventAccess({ eventId: event.id, name: "Atelier", sortOrder: 1 });
    const empty = await seedEventAccess({ eventId: event.id, name: "Vide", sortOrder: 3 });
    const other = await seedEvent();
    const otherForm = await seedForm({ eventId: other.id });
    const seed = (minutes: number, values: Partial<typeof registrations.$inferInsert> = {}) =>
      seedRegistration({ eventId: event.id, formId: form.id, submittedAt: at(minutes), ...values });

    const regs = {
      paidBoth: await seed(1, { paymentStatus: "PAID", accessTypeIds: [lunch.id, workshop.id], checkedInAt: at(100) }),
      pendingLunchTwice: await seed(2, { paymentStatus: "PENDING", accessTypeIds: [lunch.id, lunch.id] }),
      sponsoredWorkshop: await seed(2, { paymentStatus: "SPONSORED", accessTypeIds: [workshop.id], checkedInAt: at(101) }),
      waivedLunch: await seed(2, { paymentStatus: "WAIVED", accessTypeIds: [lunch.id, "gone-access"] }),
      refundedNone: await seed(3, { paymentStatus: "REFUNDED", accessTypeIds: [] }),
      partialNull: await seed(4, { paymentStatus: "PARTIAL", accessTypeIds: null }),
      verifyingLunch: await seed(5, { paymentStatus: "VERIFYING", accessTypeIds: [lunch.id], checkedInAt: at(102) }),
    };
    // Another event's registration listing this event's access id.
    await seedRegistration({
      eventId: other.id,
      formId: otherForm.id,
      submittedAt: at(3),
      paymentStatus: "PAID",
      accessTypeIds: [lunch.id],
      checkedInAt: at(103),
    });
    await getDb().insert(accessCheckIns).values([
      { registrationId: regs.paidBoth.id, accessId: lunch.id, checkedInAt: at(200), checkedInBy: "door" },
      { registrationId: regs.verifyingLunch.id, accessId: lunch.id, checkedInAt: at(201), checkedInBy: "door" },
      // A check-in for another access item does not count on the lunch sheet.
      { registrationId: regs.sponsoredWorkshop.id, accessId: workshop.id, checkedInAt: at(202), checkedInBy: "door" },
    ]);
    return { event, form, lunch, workshop, empty, regs };
  }

  it("aggregates the event summary in SQL (statuses, per-access registered and confirmed)", async () => {
    const { event, lunch, workshop, empty } = await registrationSetup();

    const summary = await getEventSummaryData(event.id);

    expect(summary.event).toEqual({ name: "Congrès", slug: event.slug });
    expect(summary.accessTypes.map((item) => item.id)).toEqual([workshop.id, lunch.id, empty.id]);
    expect(summary.total).toBe(7);
    expect([...summary.byStatus].sort(byKey((row) => row.paymentStatus))).toEqual([
      { paymentStatus: "PAID", count: 1 },
      { paymentStatus: "PARTIAL", count: 1 },
      { paymentStatus: "PENDING", count: 1 },
      { paymentStatus: "REFUNDED", count: 1 },
      { paymentStatus: "SPONSORED", count: 1 },
      { paymentStatus: "VERIFYING", count: 1 },
      { paymentStatus: "WAIVED", count: 1 },
    ]);
    // Lunch: paidBoth, pendingLunchTwice (twice, as the in-memory count did),
    // waivedLunch, verifyingLunch; confirmed = PAID + WAIVED. Unknown ids are
    // returned too (the workbook only reads the event's access items).
    expect([...summary.byAccess].sort(byKey((row) => row.accessId))).toEqual(
      [
        { accessId: lunch.id, registered: 5, confirmed: 2 },
        { accessId: workshop.id, registered: 2, confirmed: 2 },
        { accessId: "gone-access", registered: 1, confirmed: 1 },
      ].sort(byKey((row) => row.accessId)),
    );

    const none = await seedEvent();
    expect(await getEventSummaryData(none.id)).toMatchObject({ total: 0, byStatus: [], byAccess: [], accessTypes: [] });
  });

  it("reads the event and its access items in sort order", async () => {
    const { event, lunch, workshop, empty } = await registrationSetup();

    const { event: header, accessItems } = await getReportEventAndAccess(event.id);

    expect(header).toEqual({ name: "Congrès", slug: event.slug });
    expect(accessItems.map((item) => item.id)).toEqual([workshop.id, lunch.id, empty.id]);
  });

  it("pages the registrants listing an access item, newest first, this event only", async () => {
    const { event, lunch, empty, regs } = await registrationSetup();
    const expected = await getDb()
      .select({ id: registrations.id })
      .from(registrations)
      .where(eq(registrations.eventId, event.id))
      .orderBy(desc(registrations.submittedAt), desc(registrations.id));
    const lunchIds = new Set([regs.paidBoth.id, regs.pendingLunchTwice.id, regs.waivedLunch.id, regs.verifyingLunch.id]);

    for (const pageSize of [1, 2, 500]) {
      const pages = await drain(iterateAccessRegistrantsForReport(event.id, lunch.id, { pageSize }));
      expect(pages.every((page) => page.length > 0 && page.length <= pageSize)).toBe(true);
      // Listed twice, read once.
      expect(pages.flat().map((row) => row.id), `pageSize ${pageSize}`).toEqual(
        expected.map((row) => row.id).filter((id) => lunchIds.has(id)),
      );
    }
    expect(await drain(iterateAccessRegistrantsForReport(event.id, empty.id))).toEqual([]);
  });

  it("pages each half of the check-in sheets in submission order", async () => {
    const { event, lunch, workshop, empty, regs } = await registrationSetup();
    const submissionOrder = (
      await getDb()
        .select({ id: registrations.id })
        .from(registrations)
        .where(eq(registrations.eventId, event.id))
        .orderBy(asc(registrations.submittedAt), asc(registrations.id))
    ).map((row) => row.id);
    const half = async (scope: { accessId?: string; checkedIn: boolean }, pageSize = 2) => {
      const pages = await drain(iterateCheckInReportRows(event.id, scope, { pageSize }));
      expect(pages.every((page) => page.length > 0 && page.length <= pageSize)).toBe(true);
      return pages.flat();
    };
    const inOrder = (ids: string[]) => submissionOrder.filter((id) => ids.includes(id));

    // Global sheet: registrations.checked_in_at.
    const globalIn = await half({ checkedIn: true }, 1);
    expect(globalIn.map((row) => row.id)).toEqual(
      inOrder([regs.paidBoth.id, regs.sponsoredWorkshop.id, regs.verifyingLunch.id]),
    );
    expect(globalIn.map((row) => row.checkedInAt)).toEqual([at(100), at(101), at(102)]);
    const globalOut = await half({ checkedIn: false });
    expect(globalOut.map((row) => row.id)).toEqual(
      inOrder([regs.pendingLunchTwice.id, regs.waivedLunch.id, regs.refundedNone.id, regs.partialNull.id]),
    );
    expect(globalOut.every((row) => row.checkedInAt === null)).toBe(true);

    // Lunch sheet: the registrations listing lunch, by their lunch check-in row.
    const lunchIn = await half({ accessId: lunch.id, checkedIn: true });
    expect(lunchIn.map((row) => [row.id, row.checkedInAt])).toEqual([
      [regs.paidBoth.id, at(200)],
      [regs.verifyingLunch.id, at(201)],
    ]);
    const lunchOut = await half({ accessId: lunch.id, checkedIn: false });
    expect(lunchOut.map((row) => row.id)).toEqual(inOrder([regs.pendingLunchTwice.id, regs.waivedLunch.id]));
    expect(lunchOut.every((row) => row.checkedInAt === null)).toBe(true);

    // Workshop: a lunch check-in does not count; the workshop one does.
    expect((await half({ accessId: workshop.id, checkedIn: true })).map((row) => row.id)).toEqual([
      regs.sponsoredWorkshop.id,
    ]);
    expect((await half({ accessId: workshop.id, checkedIn: false })).map((row) => row.id)).toEqual([
      regs.paidBoth.id,
    ]);
    expect(await half({ accessId: empty.id, checkedIn: true })).toEqual([]);
    expect(await half({ accessId: empty.id, checkedIn: false })).toEqual([]);
  });

  it("returns the sponsorship sort keys (filtered, newest first), then the rows by id in the caller's order", async () => {
    const { event, form, regs } = await registrationSetup();
    const zeta = await seedSponsorshipBatch({ eventId: event.id, formId: form.id, labName: "Zeta Pharma", phone: "+216 71 000 000" });
    const alpha = await seedSponsorshipBatch({ eventId: event.id, formId: form.id, labName: "Alpha Labs" });
    const other = await seedEvent();
    const otherForm = await seedForm({ eventId: other.id });
    const otherBatch = await seedSponsorshipBatch({ eventId: other.id, formId: otherForm.id });

    const s1 = await seedSponsorship({ batchId: zeta.id, eventId: event.id, status: "USED", totalAmount: 300, createdAt: at(1), coveredAccessIds: ["x"] });
    const s2 = await seedSponsorship({ batchId: alpha.id, eventId: event.id, status: "PENDING", totalAmount: 100, createdAt: at(2) });
    const s3 = await seedSponsorship({ batchId: zeta.id, eventId: event.id, status: "USED", totalAmount: 200, createdAt: at(3), beneficiaryName: "Mehdi" });
    await seedSponsorship({ batchId: otherBatch.id, eventId: other.id, status: "USED", createdAt: at(4) });
    await seedSponsorshipUsage({ sponsorshipId: s1.id, registrationId: regs.paidBoth.id, amountApplied: 150, appliedAt: at(20), appliedBy: "admin" });
    await seedSponsorshipUsage({ sponsorshipId: s1.id, registrationId: regs.waivedLunch.id, amountApplied: 50, appliedAt: at(10), appliedBy: "admin" });
    // A usage whose registration is gone (FK set null).
    await seedSponsorshipUsage({ sponsorshipId: s3.id, registrationId: null, amountApplied: 200, appliedAt: at(30), appliedBy: "admin" });

    const all = await getSponsorshipsReportData(event.id);
    expect(all.currency).toBe("TND"); // no pricing row
    expect(all.event).toEqual({ name: "Congrès", slug: event.slug });
    expect(all.keys).toEqual([
      { id: s3.id, labName: "Zeta Pharma", totalAmount: 200, createdAt: at(3) },
      { id: s2.id, labName: "Alpha Labs", totalAmount: 100, createdAt: at(2) },
      { id: s1.id, labName: "Zeta Pharma", totalAmount: 300, createdAt: at(1) },
    ]);
    expect((await getSponsorshipsReportData(event.id, { status: "USED" })).keys.map((key) => key.id)).toEqual([s3.id, s1.id]);
    expect((await getSponsorshipsReportData(event.id, { search: "alpha" })).keys.map((key) => key.id)).toEqual([s2.id]);
    expect((await getSponsorshipsReportData(event.id, { search: "mehdi" })).keys.map((key) => key.id)).toEqual([s3.id]);

    // The caller's order (lab first), two ids per page; an id deleted in
    // between is skipped.
    const doomed = await seedSponsorship({ batchId: alpha.id, eventId: event.id, createdAt: at(5) });
    await getDb().delete(sponsorships).where(eq(sponsorships.id, doomed.id));
    const pages = await drain(iterateSponsorshipsForReport([s2.id, doomed.id, s1.id, s3.id], { pageSize: 2 }));
    expect(pages.map((page) => page.map((row) => row.id))).toEqual([[s2.id], [s1.id, s3.id]]);
    const [, first, third] = pages.flat();
    expect(first).toMatchObject({
      code: s1.code,
      status: "USED",
      totalAmount: 300,
      coveredAccessIds: ["x"],
      batch: { labName: "Zeta Pharma", phone: "+216 71 000 000" },
      usages: [
        { amountApplied: 50, appliedAt: at(10), registration: { email: regs.waivedLunch.email } },
        { amountApplied: 150, appliedAt: at(20), registration: { email: regs.paidBoth.email } },
      ],
    });
    expect(third!.usages).toEqual([{ amountApplied: 200, appliedAt: at(30), registration: null }]);
    expect(pages.flat()[0]!.usages).toEqual([]);
  });

  it("plans the abstracts export (ids in list order, active reviewer columns) and reads rows by id", async () => {
    const event = await seedEvent();
    const config = await seedAbstractConfig({ eventId: event.id });
    const theme = await seedAbstractTheme({ configId: config.id, label: "Cardiologie" });
    const seed = (values: Partial<typeof abstracts.$inferInsert>) => seedAbstract({ eventId: event.id, ...values });
    const a = await seed({ code: "OC-02", codeNumber: 2, status: "ACCEPTED", createdAt: at(1) });
    const b = await seed({ code: "OC-01", codeNumber: 1, status: "SUBMITTED", createdAt: at(2) });
    const c = await seed({ code: null, status: "ACCEPTED", createdAt: at(3) });
    const d = await seed({ code: null, status: "ACCEPTED", createdAt: at(4) });
    await seedAbstract({ eventId: (await seedEvent()).id, code: "OC-00" });
    await linkAbstractTheme(a.id, theme.id);
    const reviewers = await Promise.all([1, 2, 3].map(() => seedUser({ clientId: event.clientId })));
    await getDb().insert(abstractReviews).values([
      { abstractId: a.id, eventId: event.id, reviewerId: reviewers[0]!.id, active: true, score: 15, scoredAt: at(10) },
      { abstractId: a.id, eventId: event.id, reviewerId: reviewers[1]!.id, active: true },
      // Inactive reviews have no column.
      { abstractId: a.id, eventId: event.id, reviewerId: reviewers[2]!.id, active: false },
      { abstractId: b.id, eventId: event.id, reviewerId: reviewers[2]!.id, active: false },
      { abstractId: c.id, eventId: event.id, reviewerId: reviewers[2]!.id, active: true },
    ]);
    // The engine's own order for the list's sort (NULL codes sit at
    // opposite ends on PostgreSQL and CockroachDB).
    const listOrder = async (status?: "ACCEPTED") =>
      (
        await getDb()
          .select({ id: abstracts.id })
          .from(abstracts)
          .where(and(eq(abstracts.eventId, event.id), status ? eq(abstracts.status, status) : undefined))
          .orderBy(asc(abstracts.code), desc(abstracts.createdAt), asc(abstracts.id))
      ).map((row) => row.id);

    const plan = await getAbstractsExportPlan(event.id, {});
    expect(plan.ids).toEqual(await listOrder());
    expect(new Set(plan.ids)).toEqual(new Set([a.id, b.id, c.id, d.id]));
    expect(plan.maxReviews).toBe(2);

    const accepted = await getAbstractsExportPlan(event.id, { status: "ACCEPTED" });
    expect(accepted.ids).toEqual(await listOrder("ACCEPTED"));
    expect(accepted.maxReviews).toBe(2);
    const byReviewer = await getAbstractsExportPlan(event.id, { reviewerId: reviewers[2]!.id });
    expect(byReviewer).toEqual({ ids: [c.id], maxReviews: 1 });
    expect(await getAbstractsExportPlan(event.id, { status: "REJECTED" })).toEqual({ ids: [], maxReviews: 0 });

    const pages = await drain(iterateAbstractsForExport(plan.ids, { pageSize: 3 }));
    expect(pages.map((page) => page.length)).toEqual([3, 1]);
    const rows = pages.flat();
    expect(rows.map((row) => row.id)).toEqual(plan.ids);
    const rowA = rows.find((row) => row.id === a.id)!;
    expect(rowA.themes.map((t) => t.label)).toEqual(["Cardiologie"]);
    expect(rowA.reviews).toHaveLength(2);
    expect(rowA.reviews.every((review) => review.active && review.reviewer.email)).toBe(true);
    expect(rows.find((row) => row.id === b.id)!.reviews).toEqual([]);
  });
});

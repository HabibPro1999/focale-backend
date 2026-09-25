import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accessCheckIns,
  auditLogs,
  batchCheckIn,
  checkInRegistration,
  createAccessCheckIn,
  getDb,
  outboxEvents,
  registrations,
  type BatchCheckInItem,
  type CheckInWriteResult,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess, seedRegistration } from "../helpers/factories";

// Check-in writes (2.10). The event-level write is a CAS on registrations
// (checked_in_at IS NULL AND a fully settled payment status), the access-level
// write an insert that does nothing on the (registration, access) key. Audit
// and realtime outbox rows are written only on a real change, so N parallel
// scans of one badge leave exactly one check-in, one audit row and one event.
describe.runIf(dbTestsEnabled())("concurrency: check-in", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const contenders = 20;
  const at = (i: number) => new Date(Date.UTC(2030, 0, 1, 9, 0, i));

  async function auditRows(entityType: string, entityId: string) {
    return getDb()
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, entityType),
          eq(auditLogs.entityId, entityId),
          eq(auditLogs.action, "CHECK_IN"),
        ),
      );
  }

  async function realtimeRows(registrationId: string) {
    return getDb()
      .select({ id: outboxEvents.id, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateType, "registration.checkedIn"),
          eq(outboxEvents.aggregateId, registrationId),
        ),
      );
  }

  async function paidRegistration(eventId: string) {
    return seedRegistration({ eventId, paymentStatus: "PAID" });
  }

  function onlyWinner(results: CheckInWriteResult[]) {
    const winners = results.filter((r) => r.outcome === "CHECKED_IN");
    expect(winners).toHaveLength(1);
    const winner = winners[0] as Extract<CheckInWriteResult, { outcome: "CHECKED_IN" }>;
    for (const result of results) {
      if (result === winner) continue;
      expect(result).toEqual({ outcome: "ALREADY_CHECKED_IN", checkedInAt: winner.checkedInAt });
    }
    return winner;
  }

  it("parallel event-level check-ins produce one check-in, one audit row and one realtime event", async () => {
    const event = await seedEvent();
    const registration = await paidRegistration(event.id);

    const results = await Promise.all(
      Array.from({ length: contenders }, (_, i) =>
        checkInRegistration({
          registrationId: registration.id,
          eventId: event.id,
          clientId: event.clientId,
          checkedInBy: `staff-${i}`,
          checkedInAt: at(i),
        }),
      ),
    );

    const winner = onlyWinner(results);
    const winnerIndex = results.indexOf(winner);
    const [row] = await getDb()
      .select({ checkedInAt: registrations.checkedInAt, checkedInBy: registrations.checkedInBy })
      .from(registrations)
      .where(eq(registrations.id, registration.id));
    expect(row).toEqual({ checkedInAt: at(winnerIndex), checkedInBy: `staff-${winnerIndex}` });
    expect(await auditRows("Registration", registration.id)).toHaveLength(1);
    expect(await realtimeRows(registration.id)).toHaveLength(1);
  });

  it("parallel access-level check-ins produce one row and one audit row", async () => {
    const event = await seedEvent();
    const access = await seedEventAccess({ eventId: event.id });
    const registration = await seedRegistration({
      eventId: event.id,
      paymentStatus: "PAID",
      accessTypeIds: [access.id],
    });

    const results = await Promise.all(
      Array.from({ length: contenders }, (_, i) =>
        createAccessCheckIn({
          registrationId: registration.id,
          eventId: event.id,
          accessId: access.id,
          clientId: event.clientId,
          checkedInBy: `staff-${i}`,
          checkedInAt: at(i),
        }),
      ),
    );

    onlyWinner(results);
    const rows = await getDb()
      .select({ id: accessCheckIns.id })
      .from(accessCheckIns)
      .where(eq(accessCheckIns.registrationId, registration.id));
    expect(rows).toHaveLength(1);
    expect(await auditRows("AccessCheckIn", rows[0]!.id)).toHaveLength(1);
    expect(await realtimeRows(registration.id)).toHaveLength(1);
  });

  it("the CAS refuses a registration that is not fully settled or belongs to another event", async () => {
    const event = await seedEvent();
    const other = await seedEvent();
    const pending = await seedRegistration({ eventId: event.id, paymentStatus: "PENDING" });
    const elsewhere = await paidRegistration(other.id);
    const input = (registrationId: string) => ({
      registrationId,
      eventId: event.id,
      clientId: event.clientId,
      checkedInBy: "staff",
      checkedInAt: at(0),
    });

    expect(await checkInRegistration(input(pending.id))).toEqual({ outcome: "NOT_ELIGIBLE" });
    expect(await checkInRegistration(input(elsewhere.id))).toEqual({ outcome: "NOT_ELIGIBLE" });

    const rows = await getDb()
      .select({ checkedInAt: registrations.checkedInAt })
      .from(registrations)
      .where(eq(registrations.eventId, event.id));
    expect(rows).toEqual([{ checkedInAt: null }]);
    expect(await auditRows("Registration", pending.id)).toHaveLength(0);
    expect(await auditRows("Registration", elsewhere.id)).toHaveLength(0);
  });

  it("overlapping batches in opposite orders check each registration in once, without deadlocking", async () => {
    const event = await seedEvent();
    const access = await seedEventAccess({ eventId: event.id });
    const regs: Array<{ id: string }> = [];
    for (let i = 0; i < 12; i++) {
      regs.push(
        await seedRegistration({ eventId: event.id, paymentStatus: "PAID", accessTypeIds: [access.id] }),
      );
    }
    const items = (by: string): BatchCheckInItem[] =>
      regs.flatMap((reg, i) => [
        { registrationId: reg.id, eventId: event.id, clientId: event.clientId, checkedInBy: by, checkedInAt: at(i) },
        {
          registrationId: reg.id,
          eventId: event.id,
          clientId: event.clientId,
          accessId: access.id,
          checkedInBy: by,
          checkedInAt: at(i),
        },
      ]);
    const forward = items("a");
    const backward = items("b").reverse();
    const interleaved = items("c").sort((x, y) => (x.checkedInAt.getTime() % 3) - (y.checkedInAt.getTime() % 3));

    const [a, b, c] = await Promise.all([
      batchCheckIn(forward),
      batchCheckIn(backward),
      batchCheckIn(interleaved),
    ]);

    // Per item: exactly one batch checked it in; the others saw it already done.
    const outcomesFor = (registrationId: string, accessId: string | undefined) =>
      [
        [forward, a],
        [backward, b],
        [interleaved, c],
      ].map(([input, output]) => {
        const index = (input as BatchCheckInItem[]).findIndex(
          (item) => item.registrationId === registrationId && item.accessId === accessId,
        );
        return (output as CheckInWriteResult[])[index]!.outcome;
      });
    for (const reg of regs) {
      for (const accessId of [undefined, access.id]) {
        expect(outcomesFor(reg.id, accessId).sort()).toEqual([
          "ALREADY_CHECKED_IN",
          "ALREADY_CHECKED_IN",
          "CHECKED_IN",
        ]);
      }
      expect(await auditRows("Registration", reg.id)).toHaveLength(1);
      expect(await realtimeRows(reg.id)).toHaveLength(2);
    }
    expect(await getDb().select({ id: accessCheckIns.id }).from(accessCheckIns)).toHaveLength(regs.length);
  });

  it("an item whose write fails does not fail the rest of its batch", async () => {
    const event = await seedEvent();
    const first = await paidRegistration(event.id);
    const second = await paidRegistration(event.id);
    const item = (registrationId: string, accessId?: string): BatchCheckInItem => ({
      registrationId,
      eventId: event.id,
      clientId: event.clientId,
      ...(accessId ? { accessId } : {}),
      checkedInBy: "staff",
      checkedInAt: at(0),
    });

    // The access item no longer exists (FK violation), e.g. deleted after the scan.
    const results = await batchCheckIn([
      item(first.id),
      item(first.id, "deleted-access-item"),
      item(second.id),
    ]);

    expect(results[0]).toEqual({ outcome: "CHECKED_IN", checkedInAt: at(0) });
    expect(results[1]).toMatchObject({ outcome: "FAILED" });
    expect(results[2]).toEqual({ outcome: "CHECKED_IN", checkedInAt: at(0) });
    expect(await auditRows("Registration", first.id)).toHaveLength(1);
    expect(await auditRows("Registration", second.id)).toHaveLength(1);
  });
});

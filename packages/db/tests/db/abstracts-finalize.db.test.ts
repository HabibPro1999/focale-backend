import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  abstractCodeCounters,
  abstractThemes,
  abstracts,
  finalizeAbstractTxn,
  getDb,
  reopenAbstractTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  linkAbstractTheme,
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedEvent,
} from "../helpers/factories";

describe.runIf(dbTestsEnabled())("db tier: finalize / reopen", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  // N2: the port re-created abstracts_event_id_code_number_key, a unique index
  // the legacy DB deliberately dropped once the code-number counter became
  // scoped per (event, theme, finalType) — code_number is NOT unique per event,
  // only the code STRING is. Without the fix, finalizing the second theme's
  // abstract 500s on a raw 23505 unique_violation.
  it("N2: accepting abstracts under different themes both allocate code_number=1", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const config = await seedAbstractConfig({ eventId: event.id });
    const themeA = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });
    const themeB = await seedAbstractTheme({ configId: config.id, sortOrder: 1 });

    const abstractA = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    await linkAbstractTheme(abstractA.id, themeA.id);
    const abstractB = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    await linkAbstractTheme(abstractB.id, themeB.id);

    const resultA = await finalizeAbstractTxn({
      eventId: event.id,
      abstractId: abstractA.id,
      decision: "ACCEPTED",
      finalType: "ORAL_COMMUNICATION",
      performedBy: "test-admin",
    });
    const resultB = await finalizeAbstractTxn({
      eventId: event.id,
      abstractId: abstractB.id,
      decision: "ACCEPTED",
      finalType: "ORAL_COMMUNICATION",
      performedBy: "test-admin",
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const [rowA] = await getDb()
      .select({ code: abstracts.code, codeNumber: abstracts.codeNumber })
      .from(abstracts)
      .where(eq(abstracts.id, abstractA.id));
    const [rowB] = await getDb()
      .select({ code: abstracts.code, codeNumber: abstracts.codeNumber })
      .from(abstracts)
      .where(eq(abstracts.id, abstractB.id));

    expect(rowA.codeNumber).toBe(1);
    expect(rowB.codeNumber).toBe(1);
    expect(rowA.code).toBe("OC0-01");
    expect(rowB.code).toBe("OC1-01");
  });

  // H5: a valid theme reorder can still make a later allocation collide with
  // an already-issued code. This reproduces the unique violation without ever
  // violating 0006's active-theme sortOrder constraint.
  it("H5: a code collision after theme reordering returns a typed code_conflict", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const config = await seedAbstractConfig({ eventId: event.id });
    const themeA = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });
    const themeB = await seedAbstractTheme({ configId: config.id, sortOrder: 1 });

    const abstractA = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    await linkAbstractTheme(abstractA.id, themeA.id);
    const abstractB = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    await linkAbstractTheme(abstractB.id, themeB.id);

    const resultA = await finalizeAbstractTxn({
      eventId: event.id,
      abstractId: abstractA.id,
      decision: "ACCEPTED",
      finalType: "ORAL_COMMUNICATION",
      performedBy: "test-admin",
    });
    expect(resultA.ok).toBe(true);

    // The first code remains OC0-01 after its theme moves. Free slot 0 before
    // moving themeB into it, keeping both ACTIVE sort orders unique.
    await getDb()
      .update(abstractThemes)
      .set({ sortOrder: 2 })
      .where(eq(abstractThemes.id, themeA.id));
    await getDb()
      .update(abstractThemes)
      .set({ sortOrder: 0 })
      .where(eq(abstractThemes.id, themeB.id));

    // Same finalType + same sortOrder ⇒ allocateAbstractCode's per-theme counter
    // independently starts at 1 for themeB, producing the existing "OC0-01".
    const resultB = await finalizeAbstractTxn({
        eventId: event.id,
        abstractId: abstractB.id,
        decision: "ACCEPTED",
        finalType: "ORAL_COMMUNICATION",
        performedBy: "test-admin",
      });
    expect(resultB).toEqual({ ok: false, reason: "code_conflict" });

    const [unfinalized] = await getDb()
      .select({ status: abstracts.status, code: abstracts.code, codeNumber: abstracts.codeNumber })
      .from(abstracts)
      .where(eq(abstracts.id, abstractB.id));
    expect(unfinalized).toMatchObject({ status: "SUBMITTED", code: null, codeNumber: null });
    const rolledBackCounter = await getDb()
      .select({ id: abstractCodeCounters.id })
      .from(abstractCodeCounters)
      .where(eq(abstractCodeCounters.themeId, themeB.id));
    expect(rolledBackCounter).toHaveLength(0);
  });

  // M6: reopen must clear presentedAt/presentedBy from a prior decision cycle,
  // otherwise a reopened, re-decided abstract stays certificate-eligible.
  it("M6: reopen clears stale presentedAt/presentedBy", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({
      eventId: event.id,
      status: "ACCEPTED",
      finalType: "ORAL_COMMUNICATION",
      code: "OC0-01",
      codeNumber: 1,
      presentedAt: new Date(),
      presentedBy: "some-admin-id",
    });

    const result = await reopenAbstractTxn({
      eventId: event.id,
      abstractId: abstract.id,
      performedBy: "test-admin",
    });
    expect(result.ok).toBe(true);

    const [row] = await getDb()
      .select({ presentedAt: abstracts.presentedAt, presentedBy: abstracts.presentedBy })
      .from(abstracts)
      .where(eq(abstracts.id, abstract.id));
    expect(row.presentedAt).toBeNull();
    expect(row.presentedBy).toBeNull();
  });
});

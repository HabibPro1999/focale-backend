import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { abstracts, finalizeAbstractTxn, getDb, reopenAbstractTxn } from "@app/db";
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

  // H5: two themes sharing a sortOrder produce the identical code string
  // (e.g. both OC0-01), violating abstracts_event_id_code_key. Without the
  // fix, this raw 23505 escapes finalizeAbstractTxn as an opaque throw instead
  // of a typed { ok: false, reason: "code_conflict" } result.
  it("H5: two themes sharing a sortOrder surface a typed code_conflict instead of throwing", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const config = await seedAbstractConfig({ eventId: event.id });
    const themeA = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });
    const themeB = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });

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

    // Same finalType + same sortOrder ⇒ allocateAbstractCode's per-theme counter
    // independently starts at 1 for themeB, producing the same "OC0-01" string.
    await expect(
      finalizeAbstractTxn({
        eventId: event.id,
        abstractId: abstractB.id,
        decision: "ACCEPTED",
        finalType: "ORAL_COMMUNICATION",
        performedBy: "test-admin",
      }),
    ).resolves.toEqual({ ok: false, reason: "code_conflict" });
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

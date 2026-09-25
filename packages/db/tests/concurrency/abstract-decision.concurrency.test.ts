import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  abstractCodeCounters,
  abstractReviews,
  abstractRevisions,
  abstracts,
  assignReviewersTxn,
  deactivateCommitteeMembershipTxn,
  editAbstractTxn,
  finalizeAbstractTxn,
  getDb,
  pgErrorCode,
  reviewAbstractTxn,
  upsertCommitteeMembership,
  withTxn,
} from "@app/db";
import { setTimeout as sleep } from "node:timers/promises";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  linkAbstractTheme,
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedEvent,
  seedUser,
} from "../helpers/factories";

// Plan 2.9: review, assignment and edit against a finalize in flight. Each
// writer locks the abstract (edit: guarded UPDATE under SERIALIZABLE) and
// decides from the status it reads afterwards, so a decision committed while
// it waited stops it, and the decision record is not rewritten.
//
// To race deterministically, finalize is parked mid-transaction: a separate
// transaction holds the event's code-counter row, so an ACCEPTED finalize
// blocks on its counter upsert after it has locked the abstract.

const FINAL_TYPE = "ORAL_COMMUNICATION" as const;

async function seedFixture() {
  const event = await seedEvent({ status: "OPEN" });
  const config = await seedAbstractConfig({ eventId: event.id });
  const theme = await seedAbstractTheme({ configId: config.id, sortOrder: 1 });
  const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
  await linkAbstractTheme(abstract.id, theme.id);
  const r1 = await seedUser({ clientId: event.clientId });
  const r2 = await seedUser({ clientId: event.clientId });
  const r3 = await seedUser({ clientId: event.clientId });
  for (const member of [r1, r2, r3]) await upsertCommitteeMembership(event.id, member.id);
  expect(
    await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds: [r1.id, r2.id] }),
  ).toMatchObject({ ok: true });
  await getDb()
    .insert(abstractCodeCounters)
    .values({ eventId: event.id, themeId: theme.id, finalType: FINAL_TYPE, lastValue: 0 });
  return { event, theme, abstract, r1, r2, r3 };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/** True when another transaction holds a row lock on the abstract. */
async function abstractLockHeld(abstractId: string): Promise<boolean> {
  try {
    await withTxn((tx) => tx.execute(sql`SELECT id FROM abstracts WHERE id = ${abstractId} FOR UPDATE NOWAIT`));
    return false;
  } catch (error) {
    if (pgErrorCode(error) === "55P03") return true;
    throw error;
  }
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

/**
 * Start an ACCEPTED finalize and hold it after it has locked the abstract.
 * `release()` lets it commit.
 */
async function parkFinalize(f: Fixture) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const counterLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = withTxn(async (tx) => {
    await tx
      .select({ id: abstractCodeCounters.id })
      .from(abstractCodeCounters)
      .where(
        and(
          eq(abstractCodeCounters.eventId, f.event.id),
          eq(abstractCodeCounters.themeId, f.theme.id),
          eq(abstractCodeCounters.finalType, FINAL_TYPE),
        ),
      )
      .for("update");
    locked();
    await released;
  });
  await Promise.race([counterLocked, holder]);

  const finalize = finalizeAbstractTxn({
    eventId: f.event.id,
    abstractId: f.abstract.id,
    decision: "ACCEPTED",
    finalType: FINAL_TYPE,
    performedBy: "test-admin",
  });
  try {
    await vi.waitFor(async () => expect(await abstractLockHeld(f.abstract.id)).toBe(true), {
      timeout: 10_000,
      interval: 50,
    });
    expect(await settlesWithin(finalize, 200)).toBe(false);
  } catch (error) {
    release();
    await holder;
    await finalize.catch(() => undefined);
    throw error;
  }
  return {
    finalize,
    release: async () => {
      release();
      await holder;
    },
  };
}

async function readReviews(abstractId: string) {
  const rows = await getDb()
    .select({
      reviewerId: abstractReviews.reviewerId,
      active: abstractReviews.active,
      score: abstractReviews.score,
    })
    .from(abstractReviews)
    .where(eq(abstractReviews.abstractId, abstractId));
  return rows.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
}

async function readAbstract(abstractId: string) {
  const [row] = await getDb()
    .select({
      status: abstracts.status,
      code: abstracts.code,
      averageScore: abstracts.averageScore,
      reviewCount: abstracts.reviewCount,
      authorFirstName: abstracts.authorFirstName,
      contentVersion: abstracts.contentVersion,
    })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row!;
}

type ReviewTarget = { abstractId: string; event: { id: string; clientId: string } };

function review(target: ReviewTarget, reviewerId: string, score: number) {
  return reviewAbstractTxn({
    abstractId: target.abstractId,
    eventId: target.event.id,
    reviewerId,
    clientId: target.event.clientId,
    score,
    comment: null,
    commentsEnabled: false,
    divergenceThreshold: 1000,
  });
}

describe.runIf(dbTestsEnabled())("concurrency: abstract writers against a finalize", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("a review waiting on a finalize returns finalized and scores nothing", async () => {
    const f = await seedFixture();
    const before = await readReviews(f.abstract.id);
    const parked = await parkFinalize(f);

    const late = review({ abstractId: f.abstract.id, event: f.event }, f.r1.id, 17);
    expect(await settlesWithin(late, 300)).toBe(false);
    await parked.release();

    expect(await parked.finalize).toEqual({ ok: true });
    expect(await late).toEqual({ ok: false, reason: "finalized" });
    expect(await readReviews(f.abstract.id)).toEqual(before);
    expect(await readAbstract(f.abstract.id)).toMatchObject({
      status: "ACCEPTED",
      code: "OC1-01",
      averageScore: null,
      reviewCount: 0,
    });
  });

  it("an assignment waiting on a finalize returns finalized and keeps the reviewers", async () => {
    const f = await seedFixture();
    const before = await readReviews(f.abstract.id);
    const parked = await parkFinalize(f);

    const late = assignReviewersTxn({
      eventId: f.event.id,
      abstractId: f.abstract.id,
      reviewerIds: [f.r1.id, f.r3.id],
    });
    expect(await settlesWithin(late, 300)).toBe(false);
    await parked.release();

    expect(await parked.finalize).toEqual({ ok: true });
    expect(await late).toEqual({ ok: false, reason: "finalized" });
    expect(await readReviews(f.abstract.id)).toEqual(before);
    expect((await readAbstract(f.abstract.id)).status).toBe("ACCEPTED");
  });

  it("an edit waiting on a finalize returns not_editable and writes no revision", async () => {
    const f = await seedFixture();
    const parked = await parkFinalize(f);

    const late = editAbstractTxn({
      id: f.abstract.id,
      authorFirstName: "Edited",
      authorLastName: f.abstract.authorLastName,
      authorAffiliation: f.abstract.authorAffiliation ?? "",
      authorEmail: f.abstract.authorEmail,
      authorEmailNormalized: f.abstract.authorEmail.toLowerCase(),
      authorPhone: f.abstract.authorPhone,
      requestedType: f.abstract.requestedType,
      content: { body: "late edit" },
      coAuthors: [],
      additionalFieldsData: {},
      registrationId: null,
      themeIds: [f.theme.id],
      revisionSnapshot: { body: "late edit" },
      lastEditedAt: new Date(),
    });
    expect(await settlesWithin(late, 300)).toBe(false);
    await parked.release();

    expect(await parked.finalize).toEqual({ ok: true });
    expect(await late).toEqual({ ok: false, reason: "not_editable" });
    expect(await readAbstract(f.abstract.id)).toMatchObject({
      status: "ACCEPTED",
      authorFirstName: f.abstract.authorFirstName,
      contentVersion: f.abstract.contentVersion,
    });
    expect(
      await getDb().select().from(abstractRevisions).where(eq(abstractRevisions.abstractId, f.abstract.id)),
    ).toHaveLength(0);
  });

  it("parallel reviews and a finalize: the decision sticks and freezes the reviews it saw", async () => {
    const fanout = 6;
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
    const reviewers = await Promise.all(
      Array.from({ length: fanout }, () => seedUser({ clientId: event.clientId })),
    );
    for (const member of reviewers) await upsertCommitteeMembership(event.id, member.id);
    expect(
      await assignReviewersTxn({ eventId: event.id, abstractId: abstract.id, reviewerIds: reviewers.map((r) => r.id) }),
    ).toMatchObject({ ok: true });
    const target = { abstractId: abstract.id, event };

    const reviews = reviewers.map((r, i) => review(target, r.id, i + 1));
    const finalize = finalizeAbstractTxn({
      eventId: event.id,
      abstractId: abstract.id,
      decision: "REJECTED",
      finalType: undefined,
      performedBy: "test-admin",
    });
    const results = await Promise.all(reviews);
    expect(await finalize).toEqual({ ok: true });

    // Every review either committed before the decision or wrote nothing.
    for (const result of results) {
      expect(result.ok || result.reason === "finalized").toBe(true);
    }
    const committed = results.filter((r) => r.ok).length;
    const scored = (await readReviews(abstract.id)).filter((r) => r.score !== null);
    expect(scored).toHaveLength(committed);
    expect(await readAbstract(abstract.id)).toMatchObject({ status: "REJECTED", reviewCount: committed });
  });

  it("members leaving while others score keep every aggregate equal to its active reviews", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const leaverA = await seedUser({ clientId: event.clientId });
    const leaverB = await seedUser({ clientId: event.clientId });
    const stayer = await seedUser({ clientId: event.clientId });
    const members = [leaverA, leaverB, stayer];
    for (const member of members) await upsertCommitteeMembership(event.id, member.id);
    const abstractIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
      abstractIds.push(abstract.id);
      expect(
        await assignReviewersTxn({
          eventId: event.id,
          abstractId: abstract.id,
          reviewerIds: members.map((m) => m.id),
        }),
      ).toMatchObject({ ok: true });
      for (const leaver of [leaverA, leaverB]) {
        expect(await review({ abstractId: abstract.id, event }, leaver.id, 10 + i)).toMatchObject({ ok: true });
      }
    }

    // Both leavers lock the same abstracts (ascending id) while the stayer
    // scores them: no deadlock surfaces, and no recompute is lost.
    await Promise.all([
      deactivateCommitteeMembershipTxn(event.id, leaverA.id),
      deactivateCommitteeMembershipTxn(event.id, leaverB.id),
      ...abstractIds.map((abstractId, i) => review({ abstractId, event }, stayer.id, 2 + i)),
    ]);

    for (const [i, abstractId] of abstractIds.entries()) {
      const rows = await readReviews(abstractId);
      expect(rows.filter((r) => r.active).map((r) => r.reviewerId)).toEqual([stayer.id]);
      expect(await readAbstract(abstractId)).toMatchObject({
        status: "REVIEW_COMPLETE",
        reviewCount: 1,
        averageScore: 2 + i,
      });
    }
  });
});

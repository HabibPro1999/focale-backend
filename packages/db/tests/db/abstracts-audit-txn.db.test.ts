import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  abstractCommitteeMemberships,
  abstractReviewerThemes,
  abstractReviews,
  abstracts,
  assignReviewersTxn,
  deactivateCommitteeMembershipTxn,
  getDb,
  pgErrorCode,
  setReviewerThemesTxn,
  upsertCommitteeMembershipTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import {
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedEvent,
  seedUser,
  testAudit,
} from "../helpers/factories";
import { auditRowsOf } from "../helpers/sponsorship-inspect";

// Committee writes take their audit row into their own transaction: the
// change and its record commit together or not at all. The failing audit
// (NOT NULL entity_type) is inserted after every statement of the change, so
// a rollback test proves those statements are undone.

const failingAudit = () => testAudit({ entityType: null as unknown as string });

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: unknown) => err,
  );
}

async function membershipActive(eventId: string, userId: string): Promise<boolean | undefined> {
  const [row] = await getDb()
    .select({ active: abstractCommitteeMemberships.active })
    .from(abstractCommitteeMemberships)
    .where(
      and(
        eq(abstractCommitteeMemberships.eventId, eventId),
        eq(abstractCommitteeMemberships.userId, userId),
      ),
    );
  return row?.active;
}

async function activeThemeIds(eventId: string, userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractReviewerThemes.themeId })
    .from(abstractReviewerThemes)
    .where(
      and(
        eq(abstractReviewerThemes.eventId, eventId),
        eq(abstractReviewerThemes.userId, userId),
        eq(abstractReviewerThemes.active, true),
      ),
    );
  return rows.map((r) => r.themeId).sort();
}

async function activeReviewerIds(abstractId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ reviewerId: abstractReviews.reviewerId })
    .from(abstractReviews)
    .where(and(eq(abstractReviews.abstractId, abstractId), eq(abstractReviews.active, true)))
    .orderBy(asc(abstractReviews.reviewerId));
  return rows.map((r) => r.reviewerId);
}

async function abstractStatus(abstractId: string) {
  const [row] = await getDb()
    .select({ status: abstracts.status })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row?.status;
}

async function seedCommittee() {
  const event = await seedEvent({ status: "OPEN" });
  const config = await seedAbstractConfig({ eventId: event.id });
  const themeA = await seedAbstractTheme({ configId: config.id, label: "A", sortOrder: 1 });
  const themeB = await seedAbstractTheme({ configId: config.id, label: "B", sortOrder: 2 });
  const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
  const r1 = await seedUser({ clientId: event.clientId });
  const r2 = await seedUser({ clientId: event.clientId });
  await upsertCommitteeMembershipTxn(event.id, r1.id, testAudit());
  await upsertCommitteeMembershipTxn(event.id, r2.id, testAudit());
  return { event, themeA, themeB, abstract, r1, r2 };
}

describe.runIf(dbTestsEnabled())("db tier: abstracts committee audit rows share the change's transaction", () => {
  it("upsertCommitteeMembershipTxn: a failing audit insert leaves no membership and no reactivation", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const member = await seedUser({ clientId: event.clientId });
    const entityId = `${event.id}:${member.id}`;
    const audit = () =>
      testAudit({ entityType: "AbstractCommitteeMembership", entityId, action: "upsert" });

    const err = await caught(upsertCommitteeMembershipTxn(event.id, member.id, failingAudit()));

    expect(pgErrorCode(err)).toBe("23502");
    expect(await membershipActive(event.id, member.id)).toBeUndefined();
    expect(await auditRowsOf("AbstractCommitteeMembership", entityId)).toEqual([]);

    await upsertCommitteeMembershipTxn(event.id, member.id, audit());
    expect(await membershipActive(event.id, member.id)).toBe(true);
    await deactivateCommitteeMembershipTxn(event.id, member.id, testAudit());
    expect(await membershipActive(event.id, member.id)).toBe(false);

    // Reactivating an existing membership rolls back the same way.
    const reactivateErr = await caught(
      upsertCommitteeMembershipTxn(event.id, member.id, failingAudit()),
    );

    expect(pgErrorCode(reactivateErr)).toBe("23502");
    expect(await membershipActive(event.id, member.id)).toBe(false);
    expect(await auditRowsOf("AbstractCommitteeMembership", entityId)).toMatchObject([
      { action: "upsert" },
    ]);

    await upsertCommitteeMembershipTxn(event.id, member.id, audit());
    expect(await membershipActive(event.id, member.id)).toBe(true);
    expect(await auditRowsOf("AbstractCommitteeMembership", entityId)).toMatchObject([
      { action: "upsert" },
      { action: "upsert" },
    ]);
  });

  it("deactivateCommitteeMembershipTxn: a failing audit insert rolls back the deactivation", async () => {
    const { event, themeA, abstract, r1, r2 } = await seedCommittee();
    await setReviewerThemesTxn(event.id, r1.id, [themeA.id], testAudit());
    expect(
      await assignReviewersTxn({
        eventId: event.id,
        abstractId: abstract.id,
        reviewerIds: [r1.id, r2.id],
        audit: testAudit(),
      }),
    ).toMatchObject({ ok: true });
    const entityId = `${event.id}:${r1.id}`;

    const err = await caught(deactivateCommitteeMembershipTxn(event.id, r1.id, failingAudit()));

    expect(pgErrorCode(err)).toBe("23502");
    expect(await membershipActive(event.id, r1.id)).toBe(true);
    expect(await activeThemeIds(event.id, r1.id)).toEqual([themeA.id]);
    expect(await activeReviewerIds(abstract.id)).toEqual([r1.id, r2.id].sort());
    expect(await auditRowsOf("AbstractCommitteeMembership", entityId)).toEqual([]);

    await deactivateCommitteeMembershipTxn(
      event.id,
      r1.id,
      testAudit({ entityType: "AbstractCommitteeMembership", entityId, action: "deactivate" }),
    );

    expect(await membershipActive(event.id, r1.id)).toBe(false);
    expect(await activeThemeIds(event.id, r1.id)).toEqual([]);
    expect(await activeReviewerIds(abstract.id)).toEqual([r2.id]);
    expect(await auditRowsOf("AbstractCommitteeMembership", entityId)).toMatchObject([
      { action: "deactivate" },
    ]);
  });

  it("setReviewerThemesTxn: a failing audit insert keeps the previous theme set", async () => {
    const { event, themeA, themeB, r1 } = await seedCommittee();
    const entityId = `${event.id}:${r1.id}`;
    const audit = () => testAudit({ entityType: "AbstractReviewerTheme", entityId, action: "replace" });
    await setReviewerThemesTxn(event.id, r1.id, [themeA.id], audit());

    const err = await caught(setReviewerThemesTxn(event.id, r1.id, [themeB.id], failingAudit()));

    expect(pgErrorCode(err)).toBe("23502");
    expect(await activeThemeIds(event.id, r1.id)).toEqual([themeA.id]);
    expect(await auditRowsOf("AbstractReviewerTheme", entityId)).toHaveLength(1);

    await setReviewerThemesTxn(event.id, r1.id, [themeB.id], audit());

    expect(await activeThemeIds(event.id, r1.id)).toEqual([themeB.id]);
    expect(await auditRowsOf("AbstractReviewerTheme", entityId)).toHaveLength(2);
  });

  it("assignReviewersTxn: a failing audit insert leaves no assignment; a refusal writes no audit row", async () => {
    const { event, abstract, r1, r2 } = await seedCommittee();
    const audit = () =>
      testAudit({ entityType: "Abstract", entityId: abstract.id, action: "assign_reviewers" });

    const err = await caught(
      assignReviewersTxn({
        eventId: event.id,
        abstractId: abstract.id,
        reviewerIds: [r1.id, r2.id],
        audit: failingAudit(),
      }),
    );

    expect(pgErrorCode(err)).toBe("23502");
    expect(await activeReviewerIds(abstract.id)).toEqual([]);
    expect(await abstractStatus(abstract.id)).toBe("SUBMITTED");
    expect(await auditRowsOf("Abstract", abstract.id)).toEqual([]);

    const finalized = await seedAbstract({ eventId: event.id, status: "ACCEPTED" });
    expect(
      await assignReviewersTxn({
        eventId: event.id,
        abstractId: finalized.id,
        reviewerIds: [r1.id, r2.id],
        audit: testAudit({ entityType: "Abstract", entityId: finalized.id, action: "assign_reviewers" }),
      }),
    ).toEqual({ ok: false, reason: "finalized" });
    expect(await auditRowsOf("Abstract", finalized.id)).toEqual([]);

    expect(
      await assignReviewersTxn({
        eventId: event.id,
        abstractId: abstract.id,
        reviewerIds: [r1.id, r2.id],
        audit: audit(),
      }),
    ).toMatchObject({ ok: true, status: "UNDER_REVIEW" });
    expect(await activeReviewerIds(abstract.id)).toEqual([r1.id, r2.id].sort());
    expect(await auditRowsOf("Abstract", abstract.id)).toMatchObject([{ action: "assign_reviewers" }]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { UserRole } from "@app/contracts";
import { abstractReviews, emailLogs, getDb, outboxEvents, reviewAbstractTxn } from "@app/db";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedUser } from "../helpers/factories";
import { dbTestsEnabled } from "@app/db/testing";

const now = Date.parse("2035-06-01T12:30:00Z");
const hour = 3_600_000;

async function fixture(previousScores: number[]) {
  const event = await seedEvent();
  const abstract = await seedAbstract({ eventId: event.id, status: "UNDER_REVIEW" });
  const admin = await seedUser({ clientId: event.clientId, role: UserRole.CLIENT_ADMIN, active: true });
  const reviewer = await seedUser({ clientId: event.clientId, role: UserRole.SCIENTIFIC_COMMITTEE });
  for (const score of previousScores) {
    const previousReviewer = await seedUser({ clientId: event.clientId, role: UserRole.SCIENTIFIC_COMMITTEE });
    await getDb().insert(abstractReviews).values({
      eventId: event.id, abstractId: abstract.id, reviewerId: previousReviewer.id,
      active: true, score, scoredAt: new Date(now),
    });
  }
  return {
    event, abstract, admin, reviewer,
    submit: (score: number, divergenceThreshold: number) => reviewAbstractTxn({
      abstractId: abstract.id, eventId: event.id, clientId: event.clientId, reviewerId: reviewer.id,
      score, divergenceThreshold, comment: null, commentsEnabled: false,
    }),
  };
}

async function notifications(abstractId: string) {
  const emails = await getDb().select().from(outboxEvents).where(and(
    eq(outboxEvents.aggregateId, abstractId), eq(outboxEvents.type, "email.abstract"),
  ));
  const realtime = await getDb().select().from(outboxEvents).where(and(
    eq(outboxEvents.aggregateId, abstractId), eq(outboxEvents.aggregateType, "abstract.scoreDiverged"),
  ));
  return { emails, realtime };
}

describe.runIf(dbTestsEnabled())("db tier: score-divergence notifications through reviewAbstractTxn", () => {
  beforeEach(async () => {
    await cleanupDatabase();
    // Keep real timers/Date construction for PostgreSQL; fix only the alert window and dedupe bucket.
    vi.spyOn(Date, "now").mockReturnValue(now);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupDatabase();
  });

  it.each([
    { label: "one score at zero threshold", previous: [], score: 10, threshold: 0, alerts: 0 },
    { label: "equal scores at zero threshold", previous: [10], score: 10, threshold: 0, alerts: 0 },
    { label: "positive spread at zero threshold", previous: [10], score: 11, threshold: 0, alerts: 1 },
    { label: "spread below threshold", previous: [10], score: 15, threshold: 6, alerts: 0 },
    { label: "spread equal to threshold", previous: [10], score: 16, threshold: 6, alerts: 1 },
    { label: "spread above threshold", previous: [10], score: 17, threshold: 6, alerts: 1 },
  ])("$label", async ({ previous, score, threshold, alerts }) => {
    const f = await fixture(previous);
    await f.submit(score, threshold);
    const result = await notifications(f.abstract.id);
    expect(result.emails).toHaveLength(alerts);
    expect(result.realtime).toHaveLength(alerts);
  });

  it("addresses only active tenant admins and preserves alert payloads and hourly email keys", async () => {
    const f = await fixture([5]);
    const secondAdmin = await seedUser({ clientId: f.event.clientId, role: UserRole.CLIENT_ADMIN, active: true });
    await seedUser({ clientId: f.event.clientId, role: UserRole.CLIENT_ADMIN, active: false });
    const otherEvent = await seedEvent();
    await seedUser({ clientId: otherEvent.clientId, role: UserRole.CLIENT_ADMIN, active: true });
    await f.submit(17, 6);

    const stats = { averageScore: 11, reviewCount: 2, minScore: 5, maxScore: 17, divergenceThreshold: 6 };
    const result = await notifications(f.abstract.id);
    expect(result.emails).toHaveLength(2);
    for (const admin of [f.admin, secondAdmin]) {
      expect(result.emails).toContainEqual(expect.objectContaining({
        dedupeKey: `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${f.abstract.id}:${admin.email}:${Math.floor(now / hour)}`,
        payload: {
          trigger: "ABSTRACT_SCORE_DIVERGENCE", abstractId: f.abstract.id,
          recipientOverride: { email: admin.email, name: admin.name }, extraContext: stats,
        },
      }));
    }
    expect(result.realtime).toHaveLength(1);
    expect(result.realtime[0].payload).toEqual({
      type: "abstract.scoreDiverged", clientId: f.event.clientId, eventId: f.event.id,
      payload: { id: f.abstract.id, ...stats }, ts: now,
    });
  });

  it("ignores inactive scores and unscored assignments when finding divergence", async () => {
    const f = await fixture([10]);
    const inactive = await seedUser({ clientId: f.event.clientId, role: UserRole.SCIENTIFIC_COMMITTEE });
    const unscored = await seedUser({ clientId: f.event.clientId, role: UserRole.SCIENTIFIC_COMMITTEE });
    await getDb().insert(abstractReviews).values([
      { eventId: f.event.id, abstractId: f.abstract.id, reviewerId: inactive.id, active: false, score: 0, scoredAt: new Date(now) },
      { eventId: f.event.id, abstractId: f.abstract.id, reviewerId: unscored.id, active: true, score: null, scoredAt: null },
    ]);
    expect(await f.submit(10, 0)).toMatchObject({ averageScore: 10, reviewCount: 2, status: "UNDER_REVIEW" });
    expect(await notifications(f.abstract.id)).toEqual({ emails: [], realtime: [] });
  });

  it.each([
    { label: "recent failed divergence log", age: hour - 1, trigger: "ABSTRACT_SCORE_DIVERGENCE", alerts: 0 },
    { label: "divergence log exactly one hour old", age: hour, trigger: "ABSTRACT_SCORE_DIVERGENCE", alerts: 0 },
    { label: "divergence log older than one hour", age: hour + 1, trigger: "ABSTRACT_SCORE_DIVERGENCE", alerts: 1 },
    { label: "recent log for another trigger", age: 0, trigger: "ABSTRACT_SUBMISSION_ACK", alerts: 1 },
  ] as const)("$label", async ({ age, trigger, alerts }) => {
    const f = await fixture([5]);
    await getDb().insert(emailLogs).values({
      abstractId: f.abstract.id, abstractTrigger: trigger, recipientEmail: f.admin.email,
      subject: "Previous notification", status: "FAILED", queuedAt: new Date(now - age),
    });
    await f.submit(17, 6);
    const result = await notifications(f.abstract.id);
    expect(result.emails).toHaveLength(alerts);
    expect(result.realtime).toHaveLength(alerts);
  });

  it("dedupes repeated email enqueues in one hour while retaining each realtime alert", async () => {
    const f = await fixture([5]);
    await f.submit(17, 6);
    await f.submit(17, 6);
    const result = await notifications(f.abstract.id);
    expect(result.emails).toHaveLength(1);
    expect(result.realtime).toHaveLength(2);
  });
});

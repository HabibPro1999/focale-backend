import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { UserRole } from "@app/contracts";
import {
  REALTIME_EMIT_TYPE,
  abstractReviews,
  abstracts,
  emailLogs,
  finalizeAbstractTxn,
  getDb,
  outboxEvents,
  reviewAbstractTxn,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  linkAbstractTheme,
  seedAbstract,
  seedAbstractConfig,
  seedAbstractTheme,
  seedClient,
  seedEvent,
  seedUser,
} from "../helpers/factories";

// The outbox rows an abstract decision and a diverging review enqueue: the
// email.abstract payloads with their dedupe keys, and the realtime events.

const HOUR_MS = 60 * 60 * 1000;

type OutboxEmail = { dedupeKey: string | null; payload: unknown };

async function abstractEmails(abstractId: string): Promise<OutboxEmail[]> {
  const rows = await getDb()
    .select({ dedupeKey: outboxEvents.dedupeKey, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(eq(outboxEvents.type, "email.abstract"), eq(outboxEvents.aggregateId, abstractId)),
    );
  return byKey(rows);
}

function byKey(rows: OutboxEmail[]): OutboxEmail[] {
  return [...rows].sort((a, b) => String(a.dedupeKey).localeCompare(String(b.dedupeKey)));
}

async function realtimeEvents(type: string, id: string) {
  const rows = await getDb()
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, REALTIME_EMIT_TYPE),
        eq(outboxEvents.aggregateType, type),
        eq(outboxEvents.aggregateId, id),
      ),
    );
  return rows.map((row) => row.payload as { clientId: string; eventId: string; payload: unknown });
}

async function updatedAtOf(abstractId: string): Promise<Date> {
  const [row] = await getDb()
    .select({ updatedAt: abstracts.updatedAt })
    .from(abstracts)
    .where(eq(abstracts.id, abstractId));
  return row.updatedAt;
}

describe.runIf(dbTestsEnabled())("db tier: abstract decision and divergence emails", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  describe("finalize", () => {
    it("ACCEPTED queues the decision, committee-comments and final-file emails, keyed to the decision", async () => {
      const event = await seedEvent();
      const config = await seedAbstractConfig({
        eventId: event.id,
        commentsEnabled: true,
        commentsSentToAuthor: true,
        finalFileUploadEnabled: true,
      });
      const theme = await seedAbstractTheme({ configId: config.id, sortOrder: 2 });
      const abstract = await seedAbstract({ eventId: event.id, status: "REVIEW_COMPLETE" });
      await linkAbstractTheme(abstract.id, theme.id);
      const role = UserRole.SCIENTIFIC_COMMITTEE;
      const named = await seedUser({ name: "Dr Alice", role });
      const silent = await seedUser({ name: "Dr Bob", role });
      const unnamed = await seedUser({ name: "  ", role });
      const removed = await seedUser({ name: "Dr Carol", role });
      const at = (minute: number) => new Date(Date.UTC(2030, 0, 1, 10, minute));
      const review = { abstractId: abstract.id, eventId: event.id, score: 12, scoredAt: at(30) };
      await getDb().insert(abstractReviews).values([
        { ...review, reviewerId: named.id, comment: "  Clear methods. ", createdAt: at(0) },
        { ...review, reviewerId: silent.id, comment: null, createdAt: at(1) },
        { ...review, reviewerId: unnamed.id, comment: "Shorten the intro.", createdAt: at(2) },
        { ...review, reviewerId: removed.id, comment: "Gone.", active: false, createdAt: at(3) },
      ]);
      const scope = `${abstract.id}:${(await updatedAtOf(abstract.id)).getTime()}`;

      expect(
        await finalizeAbstractTxn({
          eventId: event.id,
          abstractId: abstract.id,
          decision: "ACCEPTED",
          finalType: "ORAL_COMMUNICATION",
          performedBy: "admin",
        }),
      ).toEqual({ ok: true });

      expect(await abstractEmails(abstract.id)).toEqual(
        byKey([
          {
            dedupeKey: `email:abstract:ABSTRACT_ACCEPTED:${scope}`,
            payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: abstract.id },
          },
          {
            dedupeKey: `email:abstract:ABSTRACT_COMMITTEE_COMMENTS:${scope}`,
            payload: {
              trigger: "ABSTRACT_COMMITTEE_COMMENTS",
              abstractId: abstract.id,
              extraContext: {
                committeeComments: "Dr Alice: Clear methods.\n\nReviewer 3: Shorten the intro.",
              },
            },
          },
          {
            dedupeKey: `email:abstract:ABSTRACT_FINAL_FILE_REQUEST:${scope}`,
            payload: { trigger: "ABSTRACT_FINAL_FILE_REQUEST", abstractId: abstract.id },
          },
        ]),
      );
      const finalized = await realtimeEvents("abstract.finalized", abstract.id);
      expect(finalized).toHaveLength(1);
      expect(finalized[0]).toMatchObject({
        clientId: event.clientId,
        eventId: event.id,
        payload: { id: abstract.id, status: "ACCEPTED", code: "OC2-01" },
      });
    });

    it("REJECTED queues only the rejection when comments are not sent to authors", async () => {
      const event = await seedEvent();
      await seedAbstractConfig({
        eventId: event.id,
        commentsEnabled: true,
        commentsSentToAuthor: false,
        finalFileUploadEnabled: true,
      });
      const abstract = await seedAbstract({ eventId: event.id, status: "REVIEW_COMPLETE" });
      const reviewer = await seedUser({ name: "Dr Alice", role: UserRole.SCIENTIFIC_COMMITTEE });
      await getDb().insert(abstractReviews).values({
        abstractId: abstract.id,
        eventId: event.id,
        reviewerId: reviewer.id,
        score: 4,
        comment: "Out of scope.",
        scoredAt: new Date(),
      });
      const scope = `${abstract.id}:${(await updatedAtOf(abstract.id)).getTime()}`;

      expect(
        await finalizeAbstractTxn({
          eventId: event.id,
          abstractId: abstract.id,
          decision: "REJECTED",
          finalType: undefined,
          performedBy: "admin",
        }),
      ).toEqual({ ok: true });

      expect(await abstractEmails(abstract.id)).toEqual([
        {
          dedupeKey: `email:abstract:ABSTRACT_REJECTED:${scope}`,
          payload: { trigger: "ABSTRACT_REJECTED", abstractId: abstract.id },
        },
      ]);
    });

    it("another final status queues the generic decision email, also without a config row", async () => {
      const event = await seedEvent();
      const abstract = await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
      const scope = `${abstract.id}:${(await updatedAtOf(abstract.id)).getTime()}`;

      expect(
        await finalizeAbstractTxn({
          eventId: event.id,
          abstractId: abstract.id,
          decision: "PENDING",
          finalType: undefined,
          performedBy: "admin",
        }),
      ).toEqual({ ok: true });

      expect(await abstractEmails(abstract.id)).toEqual([
        {
          dedupeKey: `email:abstract:ABSTRACT_DECISION:${scope}`,
          payload: { trigger: "ABSTRACT_DECISION", abstractId: abstract.id },
        },
      ]);
    });
  });

  describe("score divergence", () => {
    async function seedReviewedAbstract(threshold: number) {
      const client = await seedClient();
      const otherClient = await seedClient();
      const event = await seedEvent({ clientId: client.id });
      const admin = UserRole.CLIENT_ADMIN;
      const admins = [
        await seedUser({ clientId: client.id, role: admin, name: "Admin A" }),
        await seedUser({ clientId: client.id, role: admin, name: "Admin B" }),
      ];
      // Not alerted: an inactive admin, another client's admin, a reviewer.
      await seedUser({ clientId: client.id, role: admin, active: false });
      await seedUser({ clientId: otherClient.id, role: admin });
      const reviewers = [
        await seedUser({ clientId: client.id, role: UserRole.SCIENTIFIC_COMMITTEE }),
        await seedUser({ clientId: client.id, role: UserRole.SCIENTIFIC_COMMITTEE }),
        await seedUser({ clientId: client.id, role: UserRole.SCIENTIFIC_COMMITTEE }),
      ];
      const abstract = await seedAbstract({ eventId: event.id, status: "UNDER_REVIEW" });
      await getDb()
        .insert(abstractReviews)
        .values(
          reviewers.map((r) => ({ abstractId: abstract.id, eventId: event.id, reviewerId: r.id })),
        );
      const score = (reviewer: number, value: number) =>
        reviewAbstractTxn({
          abstractId: abstract.id,
          eventId: event.id,
          reviewerId: reviewers[reviewer].id,
          clientId: client.id,
          score: value,
          comment: null,
          commentsEnabled: true,
          divergenceThreshold: threshold,
        });
      return { event, abstract, admins, score };
    }

    const divergenceEmails = async (abstractId: string) =>
      (await abstractEmails(abstractId)).filter((row) =>
        String(row.dedupeKey).startsWith("email:abstract:ABSTRACT_SCORE_DIVERGENCE:"),
      );

    it("a spread reaching the threshold emails each active admin of the client and emits scoreDiverged", async () => {
      const { event, abstract, admins, score } = await seedReviewedAbstract(5);

      expect(await score(0, 10)).toMatchObject({ ok: true });
      expect(await divergenceEmails(abstract.id)).toEqual([]);

      const before = Date.now();
      expect(await score(1, 15)).toMatchObject({ ok: true, averageScore: 12.5, reviewCount: 2 });
      const after = Date.now();

      const details = {
        averageScore: 12.5,
        reviewCount: 2,
        minScore: 10,
        maxScore: 15,
        divergenceThreshold: 5,
      };
      const emails = await divergenceEmails(abstract.id);
      expect(emails).toHaveLength(2);
      const buckets = new Set([Math.floor(before / HOUR_MS), Math.floor(after / HOUR_MS)]);
      const [bucket] = [...buckets].filter((b) =>
        emails.every((row) => String(row.dedupeKey).endsWith(`:${b}`)),
      );
      expect(bucket).toBeDefined();
      expect(emails).toEqual(
        byKey(
          admins.map((admin) => ({
            dedupeKey: `email:abstract:ABSTRACT_SCORE_DIVERGENCE:${abstract.id}:${admin.email}:${bucket}`,
            payload: {
              trigger: "ABSTRACT_SCORE_DIVERGENCE",
              abstractId: abstract.id,
              recipientOverride: { email: admin.email, name: admin.name },
              extraContext: details,
            },
          })),
        ),
      );
      const diverged = await realtimeEvents("abstract.scoreDiverged", abstract.id);
      expect(diverged).toHaveLength(1);
      expect(diverged[0]).toMatchObject({
        clientId: event.clientId,
        eventId: event.id,
        payload: { id: abstract.id, ...details },
      });
    });

    it("an alert email queued within the hour suppresses the alert; an older one does not", async () => {
      const { abstract, score } = await seedReviewedAbstract(5);
      const [log] = await getDb()
        .insert(emailLogs)
        .values({
          abstractId: abstract.id,
          abstractTrigger: "ABSTRACT_SCORE_DIVERGENCE",
          recipientEmail: "admin@example.test",
          subject: "Divergence",
          queuedAt: new Date(Date.now() - 30 * 60 * 1000),
        })
        .returning({ id: emailLogs.id });

      await score(0, 10);
      expect(await score(1, 20)).toMatchObject({ ok: true, reviewCount: 2 });
      expect(await divergenceEmails(abstract.id)).toEqual([]);
      expect(await realtimeEvents("abstract.scoreDiverged", abstract.id)).toEqual([]);

      await getDb()
        .update(emailLogs)
        .set({ queuedAt: new Date(Date.now() - 61 * 60 * 1000) })
        .where(eq(emailLogs.id, log.id));
      expect(await score(2, 25)).toMatchObject({ ok: true, reviewCount: 3 });
      expect(await divergenceEmails(abstract.id)).toHaveLength(2);
      expect(await realtimeEvents("abstract.scoreDiverged", abstract.id)).toHaveLength(1);
    });

    it("no alert under the threshold, nor on a zero spread with a zero threshold", async () => {
      const under = await seedReviewedAbstract(5);
      await under.score(0, 10);
      await under.score(1, 14);
      expect(await divergenceEmails(under.abstract.id)).toEqual([]);
      expect(await realtimeEvents("abstract.scoreDiverged", under.abstract.id)).toEqual([]);

      const flat = await seedReviewedAbstract(0);
      await flat.score(0, 10);
      await flat.score(1, 10);
      expect(await divergenceEmails(flat.abstract.id)).toEqual([]);
      expect(await realtimeEvents("abstract.scoreDiverged", flat.abstract.id)).toEqual([]);
    });
  });
});

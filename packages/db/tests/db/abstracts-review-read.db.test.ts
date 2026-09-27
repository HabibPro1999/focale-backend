import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abstractReviews, findAbstractForReview, getDb } from "@app/db";
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

// What the committee's score submission reads before its transaction: the
// abstract with its event's client, the scoring config and the active reviews.

describe.runIf(dbTestsEnabled())("db tier: abstract review read", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("returns the client, scoring config and only the active reviews", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const config = await seedAbstractConfig({
      eventId: event.id,
      scoringStartAt: new Date("2030-01-01T00:00:00.000Z"),
      divergenceThreshold: 4,
      commentsEnabled: false,
    });
    const theme = await seedAbstractTheme({ configId: config.id });
    const abstract = await seedAbstract({
      eventId: event.id,
      status: "UNDER_REVIEW",
    });
    await linkAbstractTheme(abstract.id, theme.id);
    const active = await seedUser();
    const removed = await seedUser();
    await getDb()
      .insert(abstractReviews)
      .values([
        { abstractId: abstract.id, eventId: event.id, reviewerId: active.id },
        {
          abstractId: abstract.id,
          eventId: event.id,
          reviewerId: removed.id,
          active: false,
        },
      ]);

    expect(await findAbstractForReview(abstract.id)).toMatchObject({
      id: abstract.id,
      eventId: event.id,
      status: "UNDER_REVIEW",
      clientId: event.clientId,
      config: {
        scoringStartAt: new Date("2030-01-01T00:00:00.000Z"),
        scoringDeadline: null,
        divergenceThreshold: 4,
        commentsEnabled: false,
      },
      reviews: [{ reviewerId: active.id, active: true }],
    });
  });

  it("returns a null config without one and null for an unknown abstract", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id });

    expect(await findAbstractForReview(abstract.id)).toMatchObject({
      id: abstract.id,
      status: "SUBMITTED",
      clientId: event.clientId,
      config: null,
      reviews: [],
    });
    expect(await findAbstractForReview("missing-abstract")).toBeNull();
  });
});

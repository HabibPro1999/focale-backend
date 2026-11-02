import { beforeEach, describe, expect, it, vi } from "vitest";

// getAbstractForEmailContext reads the abstract, then its event's abstract
// config. No live DB — each select() resolves the next canned result set.
const selects = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("../client", () => ({
  getDb: () => ({
    select: () => {
      const rows = selects.results.shift() ?? [];
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  }),
}));

import { getAbstractForEmailContext } from "./abstracts";

const abstractRow = {
  id: "abstract-1",
  authorFirstName: "Ada",
  authorLastName: "Lovelace",
  authorEmail: "ada@example.com",
  content: { title: "On Engines" },
  status: "SUBMITTED",
  requestedType: "POSTER",
  finalType: null,
  code: null,
  editToken: "tok",
  linkBaseUrl: null,
  eventId: "event-1",
  eventName: "Congress",
  eventSlug: "congress",
  eventClientId: "client-1",
};

const configRow = (languages: unknown) => ({
  submissionStartAt: null,
  submissionDeadline: null,
  editingDeadline: null,
  scoringStartAt: null,
  scoringDeadline: null,
  finalFileDeadline: null,
  finalFileUploadEnabled: false,
  languages,
});

beforeEach(() => {
  selects.results = [];
});

describe("getAbstractForEmailContext — language", () => {
  it("uses the abstract config's primary language", async () => {
    selects.results = [[abstractRow], [configRow(["en", "fr"])]];
    const ctx = await getAbstractForEmailContext("abstract-1");
    expect(ctx?.language).toBe("en");
  });

  it("defaults to fr when the config sets no languages", async () => {
    selects.results = [[abstractRow], [configRow(null)]];
    const ctx = await getAbstractForEmailContext("abstract-1");
    expect(ctx?.language).toBe("fr");
  });

  it("defaults to fr when the event has no abstract config", async () => {
    selects.results = [[abstractRow], []];
    const ctx = await getAbstractForEmailContext("abstract-1");
    expect(ctx?.language).toBe("fr");
    expect(ctx?.config.finalFileUploadEnabled).toBe(false);
  });
});

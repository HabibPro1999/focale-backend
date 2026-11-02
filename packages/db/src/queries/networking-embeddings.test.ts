import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
import {
  claimNetworkingEmbeddingJobs,
  enqueueChangedNetworkingEmbeddings,
  getNetworkingEmbeddingHealth,
  reindexNetworkingEvent,
} from "./networking-embeddings";

const dialect = new PgDialect({ casing: "snake_case" });
const statements = () => mocks.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
const eligible = [`"p"."status"='ACTIVE'`, `"p"."consent"`, `"p"."withdrawn_at" IS NULL`, `"p"."erased_at" IS NULL`, `AND "p"."visible")`];
const gate = `"c"."config"->>'enabled'='true' AND "ev"."status"<>'ARCHIVED'`;

it("embeds only embeddable profiles of events that offer networking (4.6 policy)", async () => {
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  await enqueueChangedNetworkingEmbeddings("model");
  await claimNetworkingEmbeddingJobs(10);
  await reindexNetworkingEvent("event");
  const [enqueue, , claim, reindex] = statements();
  for (const query of [enqueue!, claim!, reindex!]) {
    for (const clause of [...eligible, gate]) expect(query.sql).toContain(clause);
    expect(query.params).toEqual(expect.arrayContaining(["networking", "registrations", "emails"]));
  }
});

it("counts the embedding status over the same embeddable profiles", async () => {
  mocks.execute.mockReset().mockResolvedValue({ rows: [] });
  await getNetworkingEmbeddingHealth("event");
  const [health] = statements();
  for (const clause of eligible) expect(health!.sql).toContain(clause);
  expect(health!.sql).toContain("count(*)::int4");
  expect(health!.params).toEqual(["event"]);
});

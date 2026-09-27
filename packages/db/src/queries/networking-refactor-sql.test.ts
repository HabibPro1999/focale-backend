import { beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => drizzle({ client: mock as unknown as Pool, casing: "snake_case" }) }));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof import("node:crypto")>()), randomUUID: () => "fixed-lock-token" }));
import { listNetworkingDiscovery, networkingEmailMetrics } from "./networking-read";
import { countNetworkingConnectionSummaries, networkingUnreadMessageCount } from "./networking-participant-read";
import { networkingParticipantExportContacts } from "./networking-contact-export";
import { claimNetworkingEmbeddingJobs, enqueueChangedNetworkingEmbeddings, getNetworkingRecommendationProfiles } from "./networking-embeddings";
import { rankNetworkingVectorCandidates } from "./networking-vector-search";

beforeEach(() => mock.query.mockReset().mockResolvedValue({ rows: [] }));
const issued = () => mock.query.mock.calls.map(([query, params]) => ({ sql: query.text as string, params }));

it("pins discovery's lateral, spaced predicates and NOT IN union with parameter order", async () => {
  await listNetworkingDiscovery("event", "viewer", ["PAID", "SPONSORED"], { excludeInteracted: true, sectors: ["Health"], page: 2, limit: 7 });
  expect(issued()).toMatchSnapshot();
});
it("pins recommendation and participant predicates without normalizing their SQL dialects", async () => {
  await getNetworkingRecommendationProfiles("event", ["target"], "viewer", ["PAID"]);
  await countNetworkingConnectionSummaries("event", "viewer", ["PAID"]);
  await rankNetworkingVectorCandidates("event", "viewer", "model", ["PAID"], 7, ["target"]);
  expect(issued()).toMatchSnapshot();
});
it("keeps contact-export's distinct visibility and registration join scope", async () => {
  await networkingUnreadMessageCount("event", "viewer");
  await networkingParticipantExportContacts("event", "viewer");
  expect(issued()).toMatchSnapshot();
});
it("pins embedding enqueue and claim entitlement clauses including archived", async () => {
  await enqueueChangedNetworkingEmbeddings("model", 7);
  await claimNetworkingEmbeddingJobs(3);
  expect(issued()).toMatchSnapshot();
});
it("pins networking email metrics scope", async () => {
  await networkingEmailMetrics("event");
  expect(issued()).toMatchSnapshot();
});

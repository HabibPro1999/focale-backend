import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const db = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => db }));

import {
  clearNetworkingVectorIndexCache,
  findNetworkingVectorCandidates,
  getNetworkingVectorIndexHealth,
  NETWORKING_EXACT_PROFILE_LIMIT,
  networkingVectorIndexStatus,
} from "./networking-vector-search";

const text = (query: SQL) => new PgDialect().sqlToQuery(query).sql;
type Responder = (sql: string) => unknown[] | undefined;
function respond(...responders: Responder[]) {
  db.execute.mockImplementation(async (query: SQL) => {
    const sql = text(query);
    for (const responder of responders) {
      const rows = responder(sql);
      if (rows) return { rows };
    }
    return { rows: [] };
  });
}
const source: Responder = (sql) => (sql.includes("pe.embedding::text AS profile") ? [{ profile: "[1]", offer: "[1]", need: "[1]", offers: "x", seeks: "y" }] : undefined);
const population = (count: number): Responder => (sql) => (sql.includes(") population") ? [{ count }] : undefined);
const index = (present: boolean): Responder => (sql) => (sql.includes("pg_catalog.pg_indexes") ? [{ present }] : undefined);
const ranked: Responder = (sql) => (sql.includes("WITH source AS") ? [{ profile_id: "p2", score: 0.9, needs_score: 1, offers_score: 1, profile_score: 0.5 }] : undefined);
const neighbors: Responder = (sql) => (sql.includes("ORDER BY embedding <=>") ? [{ profile_id: "p2" }] : undefined);
const queries = () => db.execute.mock.calls.map(([query]) => text(query as SQL));

beforeEach(() => {
  db.execute.mockReset();
  clearNetworkingVectorIndexCache();
});

describe("findNetworkingVectorCandidates without an ANN index", () => {
  it("ranks exactly up to the exact limit and never checks the index", async () => {
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT), ranked);
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).toHaveLength(1);
    expect(queries().some((sql) => sql.includes("pg_indexes"))).toBe(false);
  });
  it("falls back (null) above the limit when the index is missing, before any ANN scan", async () => {
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT + 1), index(false), neighbors, ranked);
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).toBeNull();
    expect(queries().some((sql) => sql.includes("ORDER BY embedding <=>"))).toBe(false);
  });
  it("searches the index above the limit when it exists, checking it once a minute", async () => {
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT + 1), index(true), neighbors, ranked);
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).toHaveLength(1);
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).toHaveLength(1);
    expect(queries().filter((sql) => sql.includes("pg_indexes"))).toHaveLength(1);
    expect(queries().some((sql) => sql.includes("ORDER BY embedding <=>"))).toBe(true);
  });
  it("lets the isolated benchmark measure the ANN path without an index", async () => {
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT + 1), index(false), neighbors, ranked);
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"], 60, { requireVectorIndex: false })).toHaveLength(1);
    expect(queries().some((sql) => sql.includes("pg_indexes"))).toBe(false);
  });
  it("does not cache a failed index check", async () => {
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT + 1), (sql) => {
      if (sql.includes("pg_indexes")) throw new Error("connection reset");
      return undefined;
    });
    await expect(findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).rejects.toThrow("connection reset");
    respond(source, population(NETWORKING_EXACT_PROFILE_LIMIT + 1), index(false));
    expect(await findNetworkingVectorCandidates("e", "p1", "m", ["PAID"])).toBeNull();
  });
});

describe("networkingVectorIndexStatus", () => {
  const version = (engine: string): Responder => (sql) => (sql.includes("SELECT version()") ? [{ version: engine }] : undefined);
  const large = (count: number): Responder => (sql) => (sql.includes(") large") ? [{ count }] : undefined);
  it("detects the engine and matches the 0017 name or a pgvector ANN access method", async () => {
    respond(version("CockroachDB CCL v26.2.5"), index(true), large(2));
    expect(await networkingVectorIndexStatus()).toEqual({
      engine: "cockroach", present: true, eventsAboveThreshold: 2, threshold: NETWORKING_EXACT_PROFILE_LIMIT, fallbackActive: false,
    });
    const check = queries().find((sql) => sql.includes("pg_indexes"))!;
    expect(check).toContain("tablename = 'networking_embeddings'");
    expect(check).toContain("using (hnsw|ivfflat)");
  });
  it("reports the fallback only when an event is above the limit without an index", async () => {
    respond(version("PostgreSQL 16.4"), index(false), large(0));
    expect(await networkingVectorIndexStatus({ model: "m" })).toMatchObject({ engine: "postgres", present: false, fallbackActive: false });
    const count = new PgDialect().sqlToQuery(db.execute.mock.calls.at(-1)![0] as SQL);
    expect(count.sql).toContain("HAVING count(*) >");
    expect(count.params).toEqual(["m", NETWORKING_EXACT_PROFILE_LIMIT]);
    respond(version("PostgreSQL 16.4"), index(false), large(1));
    expect(await networkingVectorIndexStatus()).toMatchObject({ fallbackActive: true, eventsAboveThreshold: 1 });
  });
});

describe("getNetworkingVectorIndexHealth", () => {
  const version: Responder = (sql) => (sql.includes("SELECT version()") ? [{ version: "CockroachDB CCL v26.2.5" }] : undefined);
  it("is unhealthy only while the fallback is active, exposes no names, and caches for a minute", async () => {
    respond(version, index(false), (sql) => (sql.includes(") large") ? [{ count: 1 }] : undefined));
    const health = await getNetworkingVectorIndexHealth("m");
    expect(health).toEqual({
      isHealthy: false, index: "missing", recommendations: "deterministic-fallback", eventsAboveThreshold: 1, threshold: NETWORKING_EXACT_PROFILE_LIMIT,
    });
    const calls = db.execute.mock.calls.length;
    expect(await getNetworkingVectorIndexHealth("m")).toBe(health);
    expect(db.execute.mock.calls.length).toBe(calls);
    clearNetworkingVectorIndexCache();
    respond(version, index(true), (sql) => (sql.includes(") large") ? [{ count: 1 }] : undefined));
    expect(await getNetworkingVectorIndexHealth("m")).toMatchObject({ isHealthy: true, index: "present", recommendations: "vector" });
  });
});

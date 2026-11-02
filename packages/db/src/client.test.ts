import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake pg Pool: records its config and hands out scripted clients. No socket
// is ever opened.
const fake = vi.hoisted(() => ({
  pools: [] as Array<{
    config: Record<string, unknown>;
    end: ReturnType<typeof vi.fn>;
    listenerCount(event: string): number;
  }>,
  query: undefined as undefined | (() => Promise<unknown>),
  release: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakePool extends Emitter {
    readonly end = vi.fn(async () => undefined);
    constructor(readonly config: Record<string, unknown>) {
      super();
      fake.pools.push(this);
    }
    async connect() {
      return { query: () => fake.query!(), release: fake.release! };
    }
  }
  return { Pool: FakePool };
});

import { attachPoolErrorHandlers, closeDb, configureDb, getDb, pingDb } from "./client";

const ENV_KEYS = ["DATABASE_URL", "DB_POOL_MAX", "DB_STATEMENT_TIMEOUT_MS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  fake.pools.length = 0;
  fake.query = async () => ({ rows: [{ "?column?": 1 }] });
  fake.release = vi.fn();
});

afterEach(async () => {
  await closeDb();
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("pool construction", () => {
  it("uses the configured application name and validated settings", async () => {
    process.env.DATABASE_URL =
      "postgresql://u:p@localhost:5432/focale_unit_test?options=-c%20TimeZone%3DAsia%2FTokyo";
    process.env.DB_POOL_MAX = "9";
    process.env.DB_STATEMENT_TIMEOUT_MS = "15000";
    configureDb({ applicationName: "focale-unit" });
    await pingDb();

    expect(fake.pools).toHaveLength(1);
    expect(fake.pools[0]!.config).toMatchObject({
      connectionString: "postgresql://u:p@localhost:5432/focale_unit_test",
      application_name: "focale-unit",
      options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=60000 -c TimeZone=UTC",
      keepAlive: true,
      max: 9,
    });
    // Idle-client and per-client error listeners are attached.
    expect(fake.pools[0]!.listenerCount("error")).toBe(1);
    expect(fake.pools[0]!.listenerCount("connect")).toBe(1);
  });

  it("refuses invalid DB_POOL_MAX when the client builds the pool", () => {
    process.env.DB_POOL_MAX = "1000";
    expect(() => getDb()).toThrow(/DB_POOL_MAX/);
    expect(fake.pools).toHaveLength(0);
  });

  it("rejects renaming the process once the pool exists", async () => {
    configureDb({ applicationName: "focale-unit" });
    await pingDb();
    expect(() => configureDb({ applicationName: "focale-unit" })).not.toThrow();
    expect(() => configureDb({ applicationName: "focale-other" })).toThrow(/before the database pool/);
    expect(() => configureDb({ applicationName: "has space" })).toThrow(/application_name/);
  });
});

describe("pingDb", () => {
  it("recycles the client and clears its timer on success", async () => {
    vi.useFakeTimers();
    await expect(pingDb(1000)).resolves.toBe(true);
    expect(fake.release).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys the client with release(true) when the query times out", async () => {
    vi.useFakeTimers();
    fake.query = () => new Promise(() => undefined);
    const result = pingDb(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(false);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys the client when the query fails", async () => {
    vi.useFakeTimers();
    const failure = new Error("connection reset");
    fake.query = () => Promise.reject(failure);
    await expect(pingDb(1000)).resolves.toBe(false);
    expect(fake.release).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns false without throwing when the pool cannot be built", async () => {
    process.env.DB_POOL_MAX = "0";
    await expect(pingDb()).resolves.toBe(false);
  });
});

describe("closeDb", () => {
  it("ends the pool once, shares concurrent closes and resets the singletons", async () => {
    await expect(closeDb()).resolves.toBeUndefined(); // nothing open yet
    await pingDb();
    const first = closeDb();
    const second = closeDb();
    expect(second).toBe(first);
    await first;
    await closeDb();
    expect(fake.pools[0]!.end).toHaveBeenCalledTimes(1);

    await pingDb();
    expect(fake.pools).toHaveLength(2);
    expect(fake.pools[1]!.end).not.toHaveBeenCalled();
  });
});

describe("attachPoolErrorHandlers", () => {
  it("logs idle and checked-out client errors once each and never throws", () => {
    const pool = new EventEmitter();
    const logger = { error: vi.fn() };
    attachPoolErrorHandlers(pool as unknown as Pool, logger);

    const idleError = new Error("idle client terminated");
    expect(() => pool.emit("error", idleError)).not.toThrow();

    // An idle client's error reaches our client listener and pg-pool's idle
    // listener, which re-emits it on the pool: logged once.
    const client = new EventEmitter();
    pool.emit("connect", client);
    client.on("error", (error) => pool.emit("error", error, client));
    const duplicated = new Error("terminating connection due to idle-in-transaction timeout");
    expect(() => client.emit("error", duplicated)).not.toThrow();

    // A checked-out client has no pool listener: only ours prevents a crash.
    const checkedOut = new EventEmitter();
    pool.emit("connect", checkedOut);
    const activeError = new Error("Connection terminated unexpectedly");
    expect(() => checkedOut.emit("error", activeError)).not.toThrow();

    expect(logger.error.mock.calls.map(([details]) => details)).toEqual([
      { err: idleError },
      { err: duplicated },
      { err: activeError },
    ]);
  });
});

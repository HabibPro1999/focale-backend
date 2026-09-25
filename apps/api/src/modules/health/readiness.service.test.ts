import { afterEach, describe, expect, it, vi } from "vitest";

const pingDb = vi.hoisted(() => vi.fn());
vi.mock("@app/db", () => ({ pingDb }));

import { ShutdownCoordinator } from "../../core/shutdown";
import { READINESS_PING_CACHE_MS, ReadinessService } from "./readiness.service";

const schemaResult = (errors: string[], skipped = false) => ({
  mode: "warn" as const,
  skipped,
  errors,
  warnings: [],
});

afterEach(() => {
  vi.useRealTimers();
  pingDb.mockReset();
});

describe("ReadinessService", () => {
  it("is ready with a reachable database and an unchecked or current schema", async () => {
    pingDb.mockResolvedValue(true);
    const readiness = new ReadinessService(new ShutdownCoordinator());
    expect(await readiness.check()).toEqual({ ready: true, status: "ready", reasons: [] });
    readiness.recordSchemaCheck(schemaResult([]));
    expect(readiness.schemaState).toBe("current");
    expect((await readiness.check()).ready).toBe(true);
    readiness.recordSchemaCheck(schemaResult([], true));
    expect(readiness.schemaState).toBe("unchecked");
  });

  it("is not ready when the boot schema check found the schema stale", async () => {
    pingDb.mockResolvedValue(true);
    const readiness = new ReadinessService(new ShutdownCoordinator());
    readiness.recordSchemaCheck(schemaResult(["Pending migrations: 0023_worker_heartbeats"]));
    expect(await readiness.check()).toEqual({
      ready: false,
      status: "not ready",
      reasons: ["database schema is not current (see the boot MIGRATIONS_CHECK log)"],
    });
  });

  it("reports draining before touching the database", async () => {
    const lifecycle = new ShutdownCoordinator();
    lifecycle.startDraining();
    const readiness = new ReadinessService(lifecycle);
    expect(await readiness.check()).toMatchObject({ ready: false, status: "draining" });
    expect(pingDb).not.toHaveBeenCalled();
  });

  it("pings the database at most once per cache window and shares a pending ping", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let release!: (ok: boolean) => void;
    pingDb.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const readiness = new ReadinessService(new ShutdownCoordinator());
    const first = readiness.check();
    const second = readiness.check();
    release(false);
    expect(await first).toMatchObject({ ready: false, reasons: ["database unreachable"] });
    expect(await second).toMatchObject({ ready: false });
    expect(pingDb).toHaveBeenCalledTimes(1);

    pingDb.mockResolvedValue(true);
    vi.advanceTimersByTime(READINESS_PING_CACHE_MS - 1);
    expect((await readiness.check()).ready).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await readiness.check()).ready).toBe(true);
    expect(pingDb).toHaveBeenCalledTimes(2);
  });
});

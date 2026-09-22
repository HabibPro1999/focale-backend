import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock("../client", () => ({ getDb: () => mocks }));
import { maintainNetworkingLifecycle } from "./networking-maintenance";
it("exposes profile photos before retention deletes their rows", async () => {
  const profiles = [{ id: "p", photoUrl: "https://storage.test/p.webp" }, { id: "q", photoUrl: null }];
  mocks.execute.mockResolvedValue({ rows: [] });
  // Retention discovery is the final execute outside the transaction.
  mocks.execute.mockImplementation(async (query) => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const text = new PgDialect().sqlToQuery(query).sql;
    return { rows: text.startsWith("SELECT c.event_id") ? [{ event_id: "event" }] : [] };
  });
  const deleted = vi.fn().mockResolvedValue(undefined);
  const beforePurge = vi.fn(async (rows) => {
    expect(deleted).not.toHaveBeenCalled();
    expect(rows).toEqual(profiles);
  });
  const selected = vi.fn().mockResolvedValue(profiles);
  mocks.transaction.mockImplementation(async (run) => run({
    execute: vi.fn(),
    select: () => ({ from: () => ({ where: selected }) }),
    delete: () => ({ where: deleted }),
  }));
  await maintainNetworkingLifecycle("event", beforePurge);
  expect(beforePurge).toHaveBeenCalledOnce();
  expect(selected).toHaveBeenCalledOnce();
  expect(deleted).toHaveBeenCalledOnce();
});

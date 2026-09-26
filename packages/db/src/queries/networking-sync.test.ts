import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../client";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn<() => DbExecutor>(() => {
    throw new Error("no database in unit tests");
  }),
  syncNetworkingRegistration: vi.fn(),
}));
vi.mock("../client", () => ({ getDb: mocks.getDb }));
vi.mock("./networking", () => ({ syncNetworkingRegistration: mocks.syncNetworkingRegistration }));

import { handleNetworkingEventSyncOutbox, handleNetworkingRegistrationSyncOutbox } from "./networking-sync";

// The chunked event sync and the outbox round trips are DB-tested
// (tests/db/networking/registration-sync.db.test.ts); these cover the handlers'
// verdicts and payload checks.
describe("networking.registration.sync handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("syncs the registration in its own serializable transaction by default", async () => {
    const tx = { executor: "transaction" } as unknown as DbExecutor;
    const transaction = vi.fn((run: (db: DbExecutor) => Promise<unknown>) => run(tx));
    mocks.getDb.mockReturnValueOnce({ transaction } as unknown as DbExecutor);
    mocks.syncNetworkingRegistration.mockResolvedValue({ created: 1, updated: 0 });
    await expect(handleNetworkingRegistrationSyncOutbox({ registrationId: "r1" }, { id: "o1" })).resolves.toBe("processed");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
    expect(mocks.syncNetworkingRegistration).toHaveBeenCalledWith("r1", tx);
  });

  it("is skipped when the sync changed nothing (withdrawn, erased, or networking off without a profile)", async () => {
    const sync = vi.fn().mockResolvedValue({ created: 0, updated: 0 });
    await expect(handleNetworkingRegistrationSyncOutbox({ registrationId: "r1" }, { id: "o1" }, sync)).resolves.toBe("skipped");
  });

  it("throws the sync's error so the outbox retries it", async () => {
    const sync = vi.fn().mockRejectedValue(new Error("serialization retries exhausted"));
    await expect(handleNetworkingRegistrationSyncOutbox({ registrationId: "r1" }, { id: "o1" }, sync)).rejects.toThrow(
      "serialization retries exhausted",
    );
  });

  it.each([null, {}, { registrationId: "" }, { registrationId: 7 }])("skips a malformed payload %j", async (payload) => {
    const sync = vi.fn();
    await expect(handleNetworkingRegistrationSyncOutbox(payload, { id: "o1" }, sync)).resolves.toBe("skipped");
    expect(sync).not.toHaveBeenCalled();
  });
});

describe("networking.event.sync handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    null,
    { runId: "run", after: null },
    { eventId: "e1", after: null },
    { eventId: "e1", runId: "run" },
    { eventId: "e1", runId: "run", after: "" },
    { eventId: "e1", runId: "run", after: 3 },
  ])("skips a malformed payload %j without reading the database", async (payload) => {
    await expect(handleNetworkingEventSyncOutbox(payload, { id: "o1" })).resolves.toBe("skipped");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: { executor: "transaction" },
  requestNetworkingEventSync: vi.fn(),
  getNetworkingEventSyncState: vi.fn(),
  assertEventAccess: vi.fn(),
  assertClientModuleEnabled: vi.fn(),
  assertEventWritable: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withLockingTxn: (run: (tx: unknown) => Promise<unknown>) => run(mocks.tx),
  requestNetworkingEventSync: mocks.requestNetworkingEventSync,
  getNetworkingEventSyncState: mocks.getNetworkingEventSyncState,
}));
vi.mock("../../core/auth/assert-event-access", () => ({ assertEventAccess: mocks.assertEventAccess }));
vi.mock("../clients/module-gates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertClientModuleEnabled: mocks.assertClientModuleEnabled,
}));
vi.mock("../events/events.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertEventWritable: mocks.assertEventWritable,
}));

import type { AuthUser } from "../../core/auth/user-cache";
import { NetworkingAdminController } from "./networking.admin.controller";

// Plan 4.8: POST /sync starts a chunked run in the worker and answers 202 with
// its state; GET /sync reads the progress.
const controller = new NetworkingAdminController({} as never, {} as never, {} as never);
const user = { id: "admin-1" } as AuthUser;
const event = { id: "ev1", clientId: "c1", status: "OPEN" };
const running = { runId: "run-1", status: "RUNNING", total: 3, processed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertEventAccess.mockResolvedValue(event);
  mocks.requestNetworkingEventSync.mockResolvedValue(running);
  mocks.getNetworkingEventSyncState.mockResolvedValue({ ...running, processed: 2 });
});

describe("NetworkingAdminController sync", () => {
  it("POST /sync answers 202 with the requested run, after the write checks", async () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, NetworkingAdminController.prototype.sync)).toBe(202);
    await expect(controller.sync(user, "ev1")).resolves.toEqual(running);
    expect(mocks.requestNetworkingEventSync).toHaveBeenCalledWith("ev1", mocks.tx);
    expect(mocks.assertClientModuleEnabled).toHaveBeenCalledWith("c1", "networking");
    expect(mocks.assertEventWritable).toHaveBeenCalledWith(event);
  });

  it("GET /sync reads the run's progress without the write check", async () => {
    await expect(controller.syncState(user, "ev1")).resolves.toMatchObject({ runId: "run-1", processed: 2 });
    expect(mocks.getNetworkingEventSyncState).toHaveBeenCalledWith("ev1");
    expect(mocks.assertEventAccess).toHaveBeenCalledWith(user, "ev1");
    expect(mocks.assertEventWritable).not.toHaveBeenCalled();
    expect(mocks.requestNetworkingEventSync).not.toHaveBeenCalled();
  });

  it("a refused access check starts nothing", async () => {
    mocks.assertEventAccess.mockRejectedValue(new Error("forbidden"));
    await expect(controller.sync(user, "ev1")).rejects.toThrow("forbidden");
    expect(mocks.requestNetworkingEventSync).not.toHaveBeenCalled();
  });
});

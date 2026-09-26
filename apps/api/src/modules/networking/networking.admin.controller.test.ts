import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestNetworkingEventSync: vi.fn(),
  getNetworkingEventSyncState: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestNetworkingEventSync: mocks.requestNetworkingEventSync,
  getNetworkingEventSyncState: mocks.getNetworkingEventSyncState,
}));
import { TENANT_SCOPE } from "../tenancy/tenant-scope";
import { NetworkingAdminController } from "./networking.admin.controller";

// Plan 4.8: POST /sync starts a chunked run in the worker and answers 202 with
// its state; GET /sync reads the progress.
const controller = new NetworkingAdminController({} as never, {} as never, {} as never);
const running = { runId: "run-1", status: "RUNNING", total: 3, processed: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestNetworkingEventSync.mockResolvedValue(running);
  mocks.getNetworkingEventSyncState.mockResolvedValue({ ...running, processed: 2 });
});

describe("NetworkingAdminController sync", () => {
  it("POST /sync answers 202 with the requested run, after the write checks", async () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, NetworkingAdminController.prototype.sync)).toBe(202);
    await expect(controller.sync("ev1")).resolves.toEqual(running);
    expect(mocks.requestNetworkingEventSync).toHaveBeenCalledWith("ev1");
    expect(Reflect.getMetadata(TENANT_SCOPE, controller.sync)).toMatchObject({ kind: "event", modules: ["networking"], write: true });
  });

  it("GET /sync reads the run's progress without the write check", async () => {
    await expect(controller.syncState("ev1")).resolves.toMatchObject({ runId: "run-1", processed: 2 });
    expect(mocks.getNetworkingEventSyncState).toHaveBeenCalledWith("ev1");
    expect(Reflect.getMetadata(TENANT_SCOPE, controller.syncState)).toMatchObject({ kind: "event", modules: ["networking"], write: false });
    expect(mocks.requestNetworkingEventSync).not.toHaveBeenCalled();
  });

  // Cross-tenant, missing, archived and disabled-module refusals run over
  // HTTP for both routes in tenant-scope.routes.test.ts.
});

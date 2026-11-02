import { describe, expect, it, vi } from "vitest";
import { ConflictException, type ArgumentsHost, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { firstValueFrom, throwError } from "rxjs";
import { NetworkingBusyError } from "@app/db";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import {
  NETWORKING_BUSY_RETRY_AFTER_SECONDS,
  NetworkingBusyException,
  NetworkingBusyInterceptor,
} from "./networking.busy";

vi.mock("../../core/logger.service", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

function reply() {
  return { sent: false, header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
}
async function intercept(error: unknown, target = reply()) {
  const context = { switchToHttp: () => ({ getResponse: () => target }) } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => throwError(() => error) };
  const thrown = await firstValueFrom(new NetworkingBusyInterceptor().intercept(context, next)).catch((e: unknown) => e);
  return { thrown, target };
}

describe("NETWORKING_BUSY", () => {
  it("maps exhausted serialization retries to 503 with Retry-After", async () => {
    const serialization = Object.assign(new Error("restart transaction"), { code: "40001" });
    const { thrown, target } = await intercept(new NetworkingBusyError({ cause: serialization }));
    expect(thrown).toBeInstanceOf(NetworkingBusyException);
    expect((thrown as NetworkingBusyException).getStatus()).toBe(503);
    expect((thrown as NetworkingBusyException).getResponse()).toEqual({
      code: "NETWORKING_BUSY", message: "Networking is busy; retry in a moment",
    });
    expect(target.header).toHaveBeenCalledWith("Retry-After", String(NETWORKING_BUSY_RETRY_AFTER_SECONDS));
  });

  it("passes every other error through untouched", async () => {
    const conflict = new ConflictException({ code: "NETWORKING_SLOT_CONFLICT", message: "taken" });
    const { thrown, target } = await intercept(conflict);
    expect(thrown).toBe(conflict);
    const raw = Object.assign(new Error("serialization"), { code: "40001" });
    expect((await intercept(raw)).thrown).toBe(raw);
    expect(target.header).not.toHaveBeenCalled();
  });

  it("renders through the global filter as the error envelope, keeping the Retry-After header", async () => {
    const target = reply();
    const { thrown } = await intercept(new NetworkingBusyError(), target);
    const host = {
      switchToHttp: () => ({ getResponse: () => target, getRequest: () => ({ url: "/api/networking/event/interests" }) }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(thrown, host);
    expect(target.status).toHaveBeenCalledWith(503);
    expect(target.send).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: { code: "NETWORKING_BUSY", message: "Networking is busy; retry in a moment" },
    }));
    expect(target.header).toHaveBeenCalledWith("Retry-After", "2");
  });
});

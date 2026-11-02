import { describe, expect, it, vi } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { ErrorCodes } from "@app/contracts";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { ZodValidationException } from "../../core/zod";
vi.mock("../../core/logger.service", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
function response(url: string, exception: unknown, route?: string) {
  const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };
  const request = { url, ...(route ? { routeOptions: { url: route } } : {}) };
  const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }) } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return reply;
}
describe("networking HTTP errors", () => {
  it.each([
    ["/api/networking/event/me", "/api/networking/:slug/me", "NETWORKING_VALIDATION"],
    ["/api/events/e1/networking/config", "/api/events/:eventId/networking/config", ErrorCodes.VALIDATION_ERROR],
    ["/api/events/e1/networking/profiles/p1", undefined, ErrorCodes.VALIDATION_ERROR],
    ["/api/events", undefined, ErrorCodes.VALIDATION_ERROR],
  ])("codes validation at %s (organizer networking routes keep VAL_2001 with details)", (url, route, code) => {
    expect(response(url, new ZodValidationException({ field: "invalid" }), route).send).toHaveBeenCalledWith(expect.objectContaining({ error: { code, message: "Validation failed", details: { field: "invalid" } } }));
  });
  it("localizes networking throttling by code", () => {
    const reply = response("/api/networking/event/messages", new ThrottlerException());
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: { code: "NETWORKING_RATE_LIMITED", message: "Too many requests" } }));
  });
  it.each(["/api/events", "/api/events?next=/networking", "/api/events/e1/networking/badges/verify"])("preserves other modules' throttling: %s", (url) => {
    const exception = new ThrottlerException();
    expect(response(url, exception).send).toHaveBeenCalledWith(expect.objectContaining({ error: { code: ErrorCodes.RATE_LIMITED, message: exception.message } }));
  });
});

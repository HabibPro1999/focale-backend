import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendProvider } from "./resend.provider";

// Real Resend SDK, fake network: proves the abort signal reaches the SDK's
// fetch call (the SDK has no timeout option of its own).
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ResendProvider send timeout", () => {
  it("passes a 15 s abort signal and the idempotency key to the SDK's fetch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "resend-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ResendProvider({ apiKey: "re_test", fromEmail: "noreply@focale.test", fromName: "Focale" });

    const result = await provider.sendEmail({ to: "a@example.com", subject: "Hi", html: "<p>Hi</p>", trackingId: "log-1" });

    expect(result).toEqual({ outcome: "accepted", success: true, messageId: "resend-id" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("log-1");
  });

  it("turns a stalled request into an ambiguous send once the signal aborts (retryable under its key)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      ),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const provider = new ResendProvider({ apiKey: "re_test", fromEmail: "noreply@focale.test", fromName: "Focale" });

    const pending = provider.sendEmail({ to: "a@example.com", subject: "Hi", html: "<p>Hi</p>", trackingId: "log-2" });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(timeout).toHaveBeenCalledWith(15_000);
    await expect(pending).resolves.toMatchObject({ outcome: "ambiguous", success: false, idempotentRetry: true });
  });

  it("an ambiguous send retried with the same trackingId reuses the idempotency key (Resend sends once)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resend-id" }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ResendProvider({ apiKey: "re_test", fromEmail: "noreply@focale.test", fromName: "Focale" });
    const input = { to: "a@example.com", subject: "Hi", html: "<p>Hi</p>", trackingId: "log-3" };

    await expect(provider.sendEmail(input)).resolves.toMatchObject({ outcome: "ambiguous", idempotentRetry: true });
    await expect(provider.sendEmail(input)).resolves.toMatchObject({ outcome: "accepted", messageId: "resend-id" });

    const keys = fetchMock.mock.calls.map((call) => new Headers((call[1] as RequestInit).headers).get("Idempotency-Key"));
    expect(keys).toEqual(["log-3", "log-3"]);
    const bodies = fetchMock.mock.calls.map((call) => (call[1] as RequestInit).body);
    expect(bodies[1]).toBe(bodies[0]);
  });
});

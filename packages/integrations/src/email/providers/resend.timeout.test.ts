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

    expect(result).toEqual({ success: true, messageId: "resend-id" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("log-1");
  });

  it("turns a stalled request into a failed send once the signal aborts", async () => {
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
    await expect(pending).resolves.toMatchObject({ success: false });
  });
});

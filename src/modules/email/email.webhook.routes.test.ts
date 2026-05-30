import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { emailWebhookRoutes } from "./email.webhook.routes.js";

const { handleWebhookMock, updateEmailStatusFromWebhookMock } = vi.hoisted(
  () => ({
    handleWebhookMock: vi.fn(),
    updateEmailStatusFromWebhookMock: vi.fn(),
  }),
);

// The route is provider-agnostic: it delegates verification/parsing to the
// active provider and only maps the result to HTTP + applies status updates.
vi.mock("./providers/index.js", () => ({
  getEmailProvider: () => ({
    name: "sendgrid",
    isConfigured: () => true,
    sendEmail: vi.fn(),
    handleWebhook: handleWebhookMock,
  }),
}));

vi.mock("./email-queue.service.js", () => ({
  updateEmailStatusFromWebhook: updateEmailStatusFromWebhookMock,
}));

async function buildTestApp() {
  const app = Fastify();
  await app.register(emailWebhookRoutes, { prefix: "/webhooks/email" });
  return app;
}

describe("email webhook routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    handleWebhookMock.mockReset();
    updateEmailStatusFromWebhookMock.mockReset().mockResolvedValue(undefined);
    app = await buildTestApp();
  });

  function post(payload = "[]") {
    return app.inject({
      method: "POST",
      url: "/webhooks/email",
      headers: { "content-type": "application/json" },
      payload,
    });
  }

  it("returns 401 when the provider reports an invalid signature", async () => {
    handleWebhookMock.mockReturnValue({
      ok: false,
      reason: "invalid_signature",
    });
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(updateEmailStatusFromWebhookMock).not.toHaveBeenCalled();
  });

  it("returns 401 for stale webhooks", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "stale" });
    expect((await post()).statusCode).toBe(401);
  });

  it("returns 503 when the provider is unconfigured", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "unconfigured" });
    expect((await post()).statusCode).toBe(503);
  });

  it("returns 400 for an unparseable payload", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "bad_payload" });
    expect((await post()).statusCode).toBe(400);
  });

  it("applies each normalized event and returns 200", async () => {
    handleWebhookMock.mockReturnValue({
      ok: true,
      logOnly: [{ type: "email.sent", emailLogId: "log-1" }],
      events: [
        { emailLogId: "log-1", type: "delivered" },
        { emailLogId: "log-2", type: "click", metadata: { url: "https://x" } },
      ],
    });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 2 });
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledTimes(2);
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledWith(
      "log-1",
      "delivered",
      undefined,
    );
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledWith(
      "log-2",
      "click",
      { url: "https://x" },
    );
  });

  it("isolates per-event failures and still returns 200", async () => {
    updateEmailStatusFromWebhookMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    handleWebhookMock.mockReturnValue({
      ok: true,
      logOnly: [],
      events: [
        { emailLogId: "log-1", type: "delivered" },
        { emailLogId: "log-2", type: "open" },
      ],
    });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledTimes(2);
  });
});

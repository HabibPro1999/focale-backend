import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleWebhookMock, updateEmailStatusFromWebhookMock } = vi.hoisted(
  () => ({
    handleWebhookMock: vi.fn(),
    updateEmailStatusFromWebhookMock: vi.fn(),
  }),
);

// The controller is provider-agnostic: it delegates verification/parsing to the
// active provider and only maps the result to HTTP + applies status updates.
vi.mock("@app/integrations", () => ({
  getEmailProvider: () => ({ handleWebhook: handleWebhookMock }),
  updateEmailStatusFromWebhook: updateEmailStatusFromWebhookMock,
}));

import { EmailWebhookController } from "./email-webhook.controller";

const controller = new EmailWebhookController();

function makeReq(rawBody = Buffer.from("[]")) {
  return { rawBody, headers: {} } as never;
}

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

beforeEach(() => {
  handleWebhookMock.mockReset();
  updateEmailStatusFromWebhookMock.mockReset().mockResolvedValue(undefined);
});

describe("EmailWebhookController", () => {
  it("returns 401 when the provider reports an invalid signature", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "invalid_signature" });
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: "Invalid signature" });
    expect(updateEmailStatusFromWebhookMock).not.toHaveBeenCalled();
  });

  it("returns 401 for stale webhooks", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "stale" });
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it("returns 503 when the provider is unconfigured", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "unconfigured" });
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toEqual({ error: "Webhook provider not configured" });
  });

  it("returns 400 for an unparseable payload", async () => {
    handleWebhookMock.mockReturnValue({ ok: false, reason: "bad_payload" });
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({ error: "Invalid payload" });
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
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ received: 2 });
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledTimes(2);
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledWith(
      "log-1",
      "delivered",
      undefined,
    );
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledWith("log-2", "click", {
      url: "https://x",
    });
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
    const reply = makeReply();
    await controller.handle(makeReq(), reply as never);

    expect(reply.statusCode).toBe(200);
    expect(updateEmailStatusFromWebhookMock).toHaveBeenCalledTimes(2);
  });

  it("passes the raw request bytes to the provider for verification", async () => {
    handleWebhookMock.mockReturnValue({ ok: true, logOnly: [], events: [] });
    const raw = Buffer.from('{"a":1}');
    await controller.handle(makeReq(raw), makeReply() as never);
    expect(handleWebhookMock).toHaveBeenCalledWith(raw, {});
  });
});

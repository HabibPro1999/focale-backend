import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { emailWebhookRoutes } from "./email.webhook.routes.js";
import { WebhookHeaders } from "./email-sendgrid.service.js";

const sendgridMocks = vi.hoisted(() => ({
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvents: vi.fn(),
}));

vi.mock("./email-sendgrid.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./email-sendgrid.service.js")>();
  return {
    ...actual,
    verifyWebhookSignature: sendgridMocks.verifyWebhookSignature,
    parseWebhookEvents: sendgridMocks.parseWebhookEvents,
  };
});

vi.mock("./email-queue.service.js", () => ({
  updateEmailStatusFromWebhook: vi.fn(),
}));

async function buildTestApp() {
  const app = Fastify();
  await app.register(emailWebhookRoutes, { prefix: "/webhook/sendgrid" });
  return app;
}

describe("email webhook routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
    sendgridMocks.verifyWebhookSignature.mockReturnValue(true);
    sendgridMocks.parseWebhookEvents.mockReturnValue([]);
  });

  it("rejects stale signed webhook timestamps", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhook/sendgrid",
      headers: {
        "content-type": "application/json",
        [WebhookHeaders.SIGNATURE.toLowerCase()]: "sig",
        [WebhookHeaders.TIMESTAMP.toLowerCase()]: String(
          Math.floor((Date.now() - 10 * 60 * 1000) / 1000),
        ),
      },
      payload: JSON.stringify([]),
    });

    expect(response.statusCode).toBe(401);
    expect(sendgridMocks.verifyWebhookSignature).not.toHaveBeenCalled();
  });
});

import { logger } from "@shared/utils/logger.js";
import { getEmailProvider } from "./providers/index.js";
import type { WebhookResult } from "./providers/index.js";
import { updateEmailStatusFromWebhook } from "./email-queue.service.js";
import type { AppInstance } from "@shared/types/fastify.js";

type WebhookFailure = Extract<WebhookResult, { ok: false }>["reason"];

function failureResponse(reason: WebhookFailure): {
  status: number;
  error: string;
} {
  switch (reason) {
    case "unconfigured":
      return { status: 503, error: "Webhook provider not configured" };
    case "bad_payload":
      return { status: 400, error: "Invalid payload" };
    case "stale":
    case "invalid_signature":
      return { status: 401, error: "Invalid signature" };
  }
}

export async function emailWebhookRoutes(app: AppInstance): Promise<void> {
  // Parse the body as a raw buffer so the active provider can verify the
  // signature against the exact bytes (ECDSA for SendGrid, Svix for Resend).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/", async (request, reply) => {
    const body = request.body as Buffer;

    const result = await getEmailProvider().handleWebhook(
      body,
      request.headers,
    );

    if (!result.ok) {
      const { status, error } = failureResponse(result.reason);
      return reply.status(status).send({ error });
    }

    for (const event of result.logOnly) {
      logger.info(
        { emailLogId: event.emailLogId, event: event.type, reason: event.reason },
        "Webhook log-only event received",
      );
    }

    for (const event of result.events) {
      await updateEmailStatusFromWebhook(
        event.emailLogId,
        event.type,
        event.metadata,
      ).catch((err) => {
        logger.error(
          { emailLogId: event.emailLogId, event: event.type, err },
          "Webhook event processing failed",
        );
      });
    }

    // Always 200 — providers retry on non-2xx.
    return reply.status(200).send({ received: result.events.length });
  });
}

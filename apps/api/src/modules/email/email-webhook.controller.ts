import {
  Controller,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createLogger } from "@app/shared";
import {
  getEmailProvider,
  updateEmailStatusFromWebhook,
  type WebhookResult,
  type WebhookHeaders,
} from "@app/integrations";
import { SkipEnvelope } from "../../core/envelope.interceptor";

const logger = createLogger({ name: "email:webhook" });

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

/**
 * Provider webhook receiver. Mounted at BOTH /webhooks/email and
 * /webhooks/sendgrid (aliases, same handler) — no auth; security is the
 * provider's signature verification over the RAW request bytes (rawBody enabled
 * at bootstrap). Responses skip the envelope so providers get the bare
 * status/body they expect. Once the batch verifies, we always return 200 (even
 * if individual status updates throw — they're caught + logged) because
 * providers retry on any non-2xx; only config/payload/signature failures map to
 * 503/400/401.
 */
@Controller()
export class EmailWebhookController {
  @Post(["webhooks/email", "webhooks/sendgrid"])
  @SkipEnvelope()
  async handle(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const body = req.rawBody ?? Buffer.alloc(0);

    const result = await getEmailProvider().handleWebhook(
      body,
      req.headers as WebhookHeaders,
    );

    if (!result.ok) {
      const { status, error } = failureResponse(result.reason);
      await reply.status(status).send({ error });
      return;
    }

    for (const event of result.logOnly) {
      logger.info(
        {
          emailLogId: event.emailLogId,
          event: event.type,
          reason: event.reason,
        },
        "Webhook log-only event received",
      );
    }

    // Sequential (not Promise.all): ordered events for the same log id (e.g.
    // delivered → opened) must apply in order. Per-event failures are isolated
    // so one bad update never aborts the batch or fails the request.
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
    await reply.status(200).send({ received: result.events.length });
  }
}

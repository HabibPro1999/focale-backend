import { z } from "zod";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import {
  verifyWebhookSignature,
  parseWebhookEvents,
  WebhookHeaders,
} from "./email-sendgrid.service.js";
import { updateEmailStatusFromWebhook } from "./email-queue.service.js";

const SendGridWebhookBodySchema = z.array(
  z
    .object({
      email: z.string(),
      event: z.string(),
      sg_message_id: z.string().optional(),
      timestamp: z.number(),
      emailLogId: z.string().optional(),
      url: z.string().optional(),
      reason: z.string().optional(),
      type: z.string().optional(),
      status: z.string().optional(),
    })
    .passthrough(), // Allow additional SendGrid fields
);

// Module-level constant — avoid recreating on every request
const EVENT_TYPE_MAP: Record<
  string,
  "delivered" | "open" | "click" | "bounce" | "dropped"
> = {
  delivered: "delivered",
  open: "open",
  click: "click",
  bounce: "bounce",
  dropped: "dropped",
};

interface RequestWithRawBody {
  rawBody: string | Buffer;
}

// IMPORTANT: This plugin MUST be registered as an encapsulated plugin (NOT via fastify-plugin)
// because it overrides the JSON content-type parser for raw body signature verification.
export async function emailWebhookRoutes(app: AppInstance): Promise<void> {
  // Register custom content type parser to capture raw body
  // for signature verification while still parsing JSON
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      // Store raw body on request for signature verification
      (req as unknown as RequestWithRawBody).rawBody = body;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    "/",
    {
      config: {
        rateLimit: { max: 100, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const rawBody = (request as unknown as RequestWithRawBody).rawBody;
      const signature = request.headers[WebhookHeaders.SIGNATURE] as
        | string
        | undefined;
      const timestamp = request.headers[WebhookHeaders.TIMESTAMP] as
        | string
        | undefined;

      // Verify webhook signature
      if (!signature || !timestamp) {
        app.log.warn("Missing webhook signature or timestamp headers");
        throw new AppError(
          "Missing signature headers",
          401,
          true,
          ErrorCodes.WEBHOOK_VERIFICATION_FAILED,
        );
      }

      const isValid = verifyWebhookSignature(rawBody, signature, timestamp);
      if (!isValid) {
        app.log.warn("Invalid webhook signature");
        throw new AppError(
          "Invalid webhook signature",
          401,
          true,
          ErrorCodes.WEBHOOK_VERIFICATION_FAILED,
        );
      }

      // Parse and validate webhook body
      // NOTE: Manual validation is required here because we use a custom content-type parser
      // for raw body signature verification, which bypasses Fastify's schema validation.
      let events;
      try {
        const validationResult = SendGridWebhookBodySchema.safeParse(
          request.body,
        );
        if (!validationResult.success) {
          // Log but return 200 to prevent SendGrid retries for bad payloads
          app.log.warn(
            { error: validationResult.error },
            "Invalid webhook payload format",
          );
          return reply.status(200).send({ received: true });
        }
        events = parseWebhookEvents(validationResult.data);
      } catch (err) {
        // Log parsing errors but return 200
        app.log.error({ err }, "Failed to parse webhook events");
        return reply.status(200).send({ received: true });
      }

      // Process events concurrently — one failure must not block others
      await Promise.allSettled(
        events.map(async (event) => {
          try {
            // Skip events without emailLogId
            if (!event.emailLogId) {
              app.log.debug(
                { event: event.event, email: event.email },
                "Skipping event without emailLogId",
              );
              return;
            }

            const mappedEventType = EVENT_TYPE_MAP[event.event];
            if (!mappedEventType) {
              // Ignore unsupported event types (processed, deferred, spam_report, etc.)
              app.log.debug(
                { event: event.event },
                "Ignoring unsupported event type",
              );
              return;
            }

            // Update email log status
            await updateEmailStatusFromWebhook(
              event.emailLogId,
              mappedEventType,
              {
                url: event.url,
                reason: event.reason,
              },
            );

            app.log.info(
              { emailLogId: event.emailLogId, event: event.event },
              "Processed webhook event",
            );
          } catch (err) {
            // Log individual event processing errors but do not rethrow
            app.log.error(
              { err, event: event.event, emailLogId: event.emailLogId },
              "Failed to process individual webhook event",
            );
          }
        }),
      );

      // Always return 200 to SendGrid to prevent retries
      return reply.status(200).send({ received: true });
    },
  );
}

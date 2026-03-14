import { logger } from '@shared/utils/logger.js';
import {
  verifyWebhookSignature,
  WebhookHeaders,
  parseWebhookEvents,
} from './email-sendgrid.service.js';
import { updateEmailStatusFromWebhook } from './email-queue.service.js';
import type { AppInstance } from '@shared/types/fastify.js';

const HANDLED_EVENTS = new Set([
  'delivered',
  'open',
  'click',
  'bounce',
  'dropped',
  'blocked',
]);

export async function emailWebhookRoutes(app: AppInstance): Promise<void> {
  // Use buffer parsing so we can verify the ECDSA signature against the raw body
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post('/', async (request, reply) => {
    const body = request.body as Buffer;
    const signature = request.headers[WebhookHeaders.SIGNATURE.toLowerCase()] as string;
    const timestamp = request.headers[WebhookHeaders.TIMESTAMP.toLowerCase()] as string;

    if (!verifyWebhookSignature(body, signature, timestamp)) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString());
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    const events = parseWebhookEvents(parsed);

    for (const event of events) {
      if (!event.emailLogId || !HANDLED_EVENTS.has(event.event)) continue;

      await updateEmailStatusFromWebhook(
        event.emailLogId,
        event.event as 'delivered' | 'open' | 'click' | 'bounce' | 'dropped' | 'blocked',
        { reason: event.reason, url: event.url },
      ).catch((err) => {
        logger.error({ emailLogId: event.emailLogId, event: event.event, err }, 'Webhook event processing failed');
      });
    }

    // Always 200 — SendGrid retries on non-2xx
    return reply.status(200).send({ received: events.length });
  });
}

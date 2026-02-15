import { config } from "@config/app.config.js";
import { logger } from "@shared/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface AlertPayload {
  title: string;
  message: string;
  severity: "info" | "warning" | "error" | "critical";
  context?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_LABELS: Record<AlertPayload["severity"], string> = {
  info: "[INFO]",
  warning: "[WARNING]",
  error: "[ERROR]",
  critical: "[CRITICAL]",
};

// ============================================================================
// Webhook Alert Utility
// ============================================================================

/**
 * Format alert payload as Slack/Discord-compatible webhook body.
 */
function formatWebhookBody(payload: AlertPayload): { text: string } {
  const timestamp = new Date().toISOString();
  const severityLabel = SEVERITY_LABELS[payload.severity];

  let text = `${severityLabel} ${payload.title}\n`;
  text += `Time: ${timestamp}\n`;
  text += `Message: ${payload.message}`;

  if (payload.context && Object.keys(payload.context).length > 0) {
    text += `\nContext: ${JSON.stringify(payload.context, null, 2)}`;
  }

  return { text };
}

/**
 * Send alert to configured webhook URL (fire-and-forget).
 * No-op if ALERT_WEBHOOK_URL is not configured.
 * Never throws, never blocks caller.
 */
export function sendAlert(payload: AlertPayload): void {
  const webhookUrl = config.alertWebhookUrl;

  // No-op if webhook URL not configured
  if (!webhookUrl) {
    return;
  }

  // Fire-and-forget: run async operation but don't await
  void (async () => {
    try {
      const body = formatWebhookBody(payload);
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, statusText: response.statusText },
          "Alert webhook request failed",
        );
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to send alert webhook",
      );
    }
  })();
}

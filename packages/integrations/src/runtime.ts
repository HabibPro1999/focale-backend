import type { AppConfig } from "@app/contracts";
import { configureDb, configureOutbox } from "@app/db";
import { configureIntegrations } from "./config";
import { setEmailStatusChangeListener } from "./email/queue";
import {
  coalesceEmailStatusChanges,
  emitEmailLogRealtimeEvents,
  type CoalescedEmailStatusListener,
} from "./email/status-coalescer";

/**
 * Hand each package its slice of the parsed config. Both apps/api/src/main.ts
 * and apps/worker/src/main.ts call this at boot. Returns the email status
 * coalescer; flush it before the pool closes.
 */
export function configureRuntime(
  config: AppConfig,
  applicationName: string,
): CoalescedEmailStatusListener {
  configureDb({
    applicationName,
    databaseUrl: config.DATABASE_URL,
    settings: config.database,
    jsonbValidation: config.JSONB_VALIDATION,
  });
  configureIntegrations(config.integrations);
  // REALTIME_DISABLED: realtime.emit rows are not written (nothing drains
  // them: the API pump is off). Set it on both services.
  configureOutbox({ realtimeDisabled: config.realtime.disabled });

  // N3: emails can be queued/updated from either process — both install the
  // same listener here so no email-log status change is silently dropped
  // depending on which process handled it. Coalesced per 250 ms (one event
  // per event and status, listing the email logs); flushed before the pool
  // closes. Not installed when realtime is disabled (nothing to emit).
  const emailStatus = coalesceEmailStatusChanges(emitEmailLogRealtimeEvents);
  if (!config.realtime.disabled)
    setEmailStatusChangeListener(emailStatus.listener);
  return emailStatus;
}

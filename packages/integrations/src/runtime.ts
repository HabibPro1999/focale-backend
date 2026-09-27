import type { AppConfig } from "@app/contracts";
import { configureDb } from "@app/db";
import type { Logger } from "@app/shared";
import { configureIntegrations } from "./config";
import { emitEmailLogRealtimeEvent, setEmailStatusChangeListener } from "./email/queue";

/** Install at module scope, before config parsing, with the process's own logger. */
export function registerUnhandledRejectionLogger(logger: Pick<Logger, "error">): void {
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
    // Don't exit - let the application continue
  });
}

/** Both processes configure the same slices and email status listener in this order. */
export function configureRuntime(config: AppConfig, applicationName: string): void {
  configureDb({
    applicationName,
    databaseUrl: config.DATABASE_URL,
    settings: config.database,
  });
  configureIntegrations(config.integrations);
  setEmailStatusChangeListener(emitEmailLogRealtimeEvent);
}

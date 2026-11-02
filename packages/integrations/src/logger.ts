import { createLogger, type Logger } from "@app/shared";

/** Shared logger for the integrations package (Firebase, storage, email providers). */
export const logger: Logger = createLogger({ name: "@app/integrations" });

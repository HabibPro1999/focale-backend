import { createLogger, type Logger } from "@app/shared";
import { getRequestId } from "./request-context";

/** Module-level singleton — usable before DI boots (e.g. in main.ts). */
export const logger: Logger = createLogger({
  name: "api",
  mixin: () => ({ requestId: getRequestId() }),
});

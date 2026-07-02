import { Injectable, type LoggerService as NestLoggerService } from "@nestjs/common";
import { createLogger, type Logger } from "@app/shared";
import { getRequestId } from "./request-context";

/** Module-level singleton — usable before DI boots (e.g. in main.ts). */
export const logger: Logger = createLogger({
  name: "api",
  mixin: () => ({ requestId: getRequestId() }),
});

/** Nest-facing adapter that delegates to the shared pino singleton. */
@Injectable()
export class LoggerService implements NestLoggerService {
  log(message: unknown, ...meta: unknown[]): void {
    logger.info({ meta }, String(message));
  }
  error(message: unknown, ...meta: unknown[]): void {
    logger.error({ meta }, String(message));
  }
  warn(message: unknown, ...meta: unknown[]): void {
    logger.warn({ meta }, String(message));
  }
  debug(message: unknown, ...meta: unknown[]): void {
    logger.debug({ meta }, String(message));
  }
  verbose(message: unknown, ...meta: unknown[]): void {
    logger.trace({ meta }, String(message));
  }
}

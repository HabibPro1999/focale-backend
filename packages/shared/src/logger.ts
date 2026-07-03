import { pino, type Logger, type LoggerOptions } from "pino";

export type CreateLoggerOptions = {
  name: string;
  level?: string;
  mixin?: LoggerOptions["mixin"];
};

/** pino factory. Level from LOG_LEVEL (default info). pino-pretty only outside production and when available. */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const options: LoggerOptions = {
    name: opts.name,
    level,
    redact: ["req.headers.authorization", "password", "token"],
  };
  if (opts.mixin) options.mixin = opts.mixin;

  if (process.env.NODE_ENV !== "production") {
    try {
      require.resolve("pino-pretty");
      options.transport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      };
    } catch {
      // pino-pretty not installed — fall back to JSON logs.
    }
  }

  return pino(options);
}

export type { Logger };

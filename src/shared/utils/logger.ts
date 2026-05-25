import pino, { type LoggerOptions } from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

const options: LoggerOptions = {
  level: isDevelopment ? "debug" : "info",
  redact: ["req.headers.authorization", "password", "token"],
};

// Only add pino-pretty transport in development (it's a devDependency)
if (isDevelopment) {
  options.transport = { target: "pino-pretty", options: { colorize: true } };
}

export const logger = pino(options);

import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export type CreateLoggerOptions = {
  name: string;
  level?: string;
  mixin?: LoggerOptions["mixin"];
  /** Explicit sink (tests). Disables the pino-pretty transport. */
  destination?: DestinationStream;
};

// ---------------------------------------------------------------------------
// PII-safe error serialization
// ---------------------------------------------------------------------------

/**
 * Error properties never logged: drizzle's DrizzleQueryError carries the SQL
 * (`query`) and bound values (`params`); pg's DatabaseError `detail` echoes
 * row values (`Key (email)=(…) already exists`) and `internalQuery` holds SQL.
 */
const DROPPED_ERROR_KEYS = new Set(["params", "query", "detail", "internalQuery"]);

// drizzle-orm DrizzleQueryError: `Failed query: ${query}\nparams: ${params}`.
const DRIZZLE_FAILED_QUERY = /^Failed query: /;
const REDACTED_QUERY_MESSAGE = "Failed query (SQL text and parameters redacted)";
// SQLSTATE class 22 (data exception) messages echo the offending input value,
// e.g. `invalid input syntax for type uuid: "…"`.
const DATA_EXCEPTION_SQLSTATE = /^22[0-9A-Z]{3}$/;
const REDACTED_DATA_EXCEPTION_MESSAGE = "Data exception (message redacted)";
const MAX_CAUSE_DEPTH = 10;

type ErrorLike = { message: string; stack?: unknown; code?: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function sanitizedMessage(err: ErrorLike): string {
  if (DRIZZLE_FAILED_QUERY.test(err.message)) return REDACTED_QUERY_MESSAGE;
  if (typeof err.code === "string" && DATA_EXCEPTION_SQLSTATE.test(err.code)) {
    return REDACTED_DATA_EXCEPTION_MESSAGE;
  }
  return err.message;
}

/** The V8 stack header embeds the message; rewrite it (or keep only frames). */
function sanitizedStack(stack: unknown, original: string, replacement: string): unknown {
  if (typeof stack !== "string" || original === replacement) return stack;
  if (original !== "" && stack.includes(original)) {
    return stack.replace(original, () => replacement);
  }
  const frames = stack.split("\n").filter((line) => /^\s+at\s/.test(line));
  return [replacement, ...frames].join("\n");
}

function sanitize(value: unknown, seen: Map<object, unknown>, depth: number): unknown {
  if (!isErrorLike(value)) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (depth > MAX_CAUSE_DEPTH) return undefined;

  // Same prototype so the serializer's `type` (constructor name) survives.
  const clone = Object.create(Object.getPrototypeOf(value) as object) as Record<string, unknown>;
  seen.set(value, clone);
  const message = sanitizedMessage(value);

  // Own names include the non-enumerable message/stack/cause/errors of native errors.
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DROPPED_ERROR_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const original = (value as unknown as Record<string, unknown>)[key];
    let next: unknown;
    if (key === "message") next = message;
    else if (key === "stack") next = sanitizedStack(original, value.message, message);
    else if (key === "cause") next = sanitize(original, seen, depth + 1);
    else if (key === "errors" && Array.isArray(original)) {
      next = original.map((item) => sanitize(item, seen, depth + 1));
    } else next = original;
    Object.defineProperty(clone, key, {
      value: next,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      configurable: true,
    });
  }
  // An error-like object whose message is inherited/accessor-only.
  if (!Object.prototype.hasOwnProperty.call(clone, "message")) {
    Object.defineProperty(clone, "message", {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return clone;
}

/**
 * Copy of an error (and its cause chain) that is safe to log: drops SQL,
 * bound parameters and pg `detail`, and replaces value-bearing messages.
 * The original error is never mutated. Non-error values pass through.
 */
export function sanitizeErrorForLog(err: unknown): unknown {
  return sanitize(err, new Map(), 0);
}

/** pino's standard `err` serializer applied to the sanitized copy. */
export function serializeErrorForLog(err: unknown): unknown {
  const sanitized = sanitizeErrorForLog(err);
  return stdSerializers.err(sanitized as Error);
}

// Serializers run before redaction; these paths also cover non-Error `err`
// values and payloads that carry an edit token.
const REDACT_PATHS = [
  "req.headers.authorization",
  "password",
  "token",
  "editToken",
  "*.editToken",
  "err.params",
  "err.query",
];

/** pino factory. Level from LOG_LEVEL (default info). pino-pretty only outside production and when available. */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const options: LoggerOptions = {
    name: opts.name,
    level,
    redact: REDACT_PATHS,
    serializers: { err: serializeErrorForLog },
  };
  if (opts.mixin) options.mixin = opts.mixin;

  if (opts.destination) return pino(options, opts.destination);

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

import { describe, expect, it } from "vitest";
import { createLogger, sanitizeErrorForLog } from "./logger";

const EMAIL = "alice@example.com";
const SQL = 'insert into "registrations" ("email", "form_id") values ($1, $2)';

/** Same constructor/message shape as drizzle-orm's DrizzleQueryError. */
class FakeDrizzleQueryError extends Error {
  constructor(
    public query: string,
    public params: unknown[],
    cause?: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
    this.cause = cause;
  }
}

function pgUniqueError(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "registrations_email_form_id_key"'),
    {
      code: "23505",
      detail: `Key (email, form_id)=(${EMAIL}, form-1) already exists.`,
      table: "registrations",
      constraint: "registrations_email_form_id_key",
      internalQuery: SQL,
    },
  );
}

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    name: "test",
    level: "trace",
    destination: { write: (line: string) => void lines.push(line) },
  });
  return { logger, output: () => lines.join("\n"), lines };
}

describe("createLogger err serializer", () => {
  it("drops SQL, params and pg detail from a Drizzle query error and its cause", () => {
    const { logger, output, lines } = captureLogger();
    const err = new FakeDrizzleQueryError(SQL, [EMAIL, "form-1"], pgUniqueError());

    logger.error({ err }, "boom");

    const text = output();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("insert into");
    expect(text).not.toContain("params:");
    const entry = JSON.parse(lines[0]);
    expect(entry.err.type).toBe("FakeDrizzleQueryError");
    expect(entry.err.message).toContain("Failed query (SQL text and parameters redacted)");
    // The pg cause message carries no values and stays useful for debugging.
    expect(entry.err.message).toContain("registrations_email_form_id_key");
    expect(entry.err.stack).toContain("Failed query (SQL text and parameters redacted)");
    expect(entry.err).not.toHaveProperty("params");
    expect(entry.err).not.toHaveProperty("query");
  });

  it("sanitizes nested and non-enumerable causes", () => {
    const { logger, output } = captureLogger();
    const drizzle = new FakeDrizzleQueryError(SQL, [EMAIL], pgUniqueError());
    const err = new Error("service failed", { cause: new Error("wrapper", { cause: drizzle }) });

    logger.error({ err }, "boom");

    const text = output();
    expect(text).toContain("service failed");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("insert into");
  });

  it("redacts the value-echoing message of SQLSTATE class 22 errors", () => {
    const { logger, output } = captureLogger();
    const err = Object.assign(
      new Error(`invalid input syntax for type uuid: "${EMAIL}"`),
      { code: "22P02" },
    );

    logger.error({ err }, "boom");

    expect(output()).not.toContain(EMAIL);
    expect(output()).toContain("22P02");
  });

  it("keeps non-database error messages and stacks", () => {
    const { logger, lines } = captureLogger();
    logger.error({ err: new Error("plain failure") }, "boom");
    const entry = JSON.parse(lines[0]);
    expect(entry.err.message).toBe("plain failure");
    expect(entry.err.stack).toContain("plain failure");
  });

  it("does not mutate the logged error", () => {
    const { logger } = captureLogger();
    const err = new FakeDrizzleQueryError(SQL, [EMAIL], pgUniqueError());
    logger.error({ err }, "boom");
    expect(err.message).toContain(EMAIL);
    expect(err.params).toEqual([EMAIL]);
  });
});

describe("createLogger redaction", () => {
  it("redacts edit tokens, raw err params/query and the existing paths", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        editToken: "top-secret-token",
        registration: { editToken: "nested-secret-token" },
        password: "pw-secret",
        token: "bearer-secret",
        req: { headers: { authorization: "Bearer auth-secret" } },
      },
      "payload",
    );
    // A non-Error `err` value bypasses the serializer; redaction still applies.
    logger.warn({ err: { params: [EMAIL], query: SQL, code: "23505" } }, "raw");

    const text = output();
    for (const secret of [
      "top-secret-token",
      "nested-secret-token",
      "pw-secret",
      "bearer-secret",
      "auth-secret",
      EMAIL,
      "insert into",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("23505");
  });
});

describe("sanitizeErrorForLog", () => {
  it("returns non-error values unchanged", () => {
    expect(sanitizeErrorForLog("x")).toBe("x");
    expect(sanitizeErrorForLog(undefined)).toBeUndefined();
  });

  it("survives circular cause chains", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    const clean = sanitizeErrorForLog(a) as Error & { cause?: Error };
    expect(clean.message).toBe("a");
    expect(clean.cause?.message).toBe("b");
  });
});

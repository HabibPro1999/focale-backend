import { createRequire } from "node:module";
import path from "node:path";
import type { ArgumentsHost } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the real shared logger (serializers + redaction) writes.
const sink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("./logger.service", async () => {
  const { createLogger } = await import("@app/shared");
  return {
    logger: createLogger({
      name: "api",
      level: "trace",
      destination: { write: (line: string) => void sink.lines.push(line) },
    }),
  };
});

import { HttpExceptionFilter } from "./http-exception.filter";

// The real drizzle-orm / pg error classes at the installed versions, resolved
// through @app/db (apps/api has no direct dependency on either package).
const requireFromDb = createRequire(
  path.resolve(__dirname, "../../../../packages/db/package.json"),
);
type DrizzleQueryErrorCtor = new (
  query: string,
  params: unknown[],
  cause?: Error,
) => Error & { query: string; params: unknown[] };
type PgDatabaseErrorCtor = new (message: string, length: number, name: string) => Error;
const { DrizzleQueryError } = requireFromDb("drizzle-orm") as {
  DrizzleQueryError: DrizzleQueryErrorCtor;
};
const { DatabaseError } = requireFromDb("pg") as { DatabaseError: PgDatabaseErrorCtor };

const EMAIL = "alice.registrant@example.com";
const SQL =
  'insert into "registrations" ("id", "email", "form_id") values (default, $1, $2) returning "id"';

function pgError(fields: Record<string, unknown>, message: string): Error {
  return Object.assign(new DatabaseError(message, message.length, "error"), fields);
}

function uniqueViolation() {
  const cause = pgError(
    {
      code: "23505",
      severity: "ERROR",
      detail: `Key (email, form_id)=(${EMAIL}, 0191aa00-0000-7000-8000-000000000001) already exists.`,
      schema: "public",
      table: "registrations",
      constraint: "registrations_email_form_id_key",
    },
    'duplicate key value violates unique constraint "registrations_email_form_id_key"',
  );
  return new DrizzleQueryError(SQL, [EMAIL, "0191aa00-0000-7000-8000-000000000001"], cause);
}

function makeHost(url = "/api/public/forms/f1/register") {
  const reply = {
    header: vi.fn((..._args: unknown[]) => reply),
    status: vi.fn((..._args: unknown[]) => reply),
    send: vi.fn((..._args: unknown[]) => reply),
  };
  const request = { url, routeOptions: { url } };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

function logged(): string {
  return sink.lines.join("\n");
}

describe("HttpExceptionFilter — database errors are logged without PII", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    sink.lines.length = 0;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("logs a constraint violation as { code, constraint, table } only", () => {
    const err = uniqueViolation();
    // Sanity: the raw error really embeds the SQL, the params and the email.
    expect(err.message).toContain(EMAIL);
    expect(err.message).toContain("insert into");

    const { host, reply } = makeHost();
    new HttpExceptionFilter().catch(err, host);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: ErrorCodes.REGISTRATION_ALREADY_EXISTS }),
      }),
    );
    expect(sink.lines).toHaveLength(1);
    const entry = JSON.parse(sink.lines[0]);
    expect(entry).toMatchObject({
      msg: "Database constraint error",
      code: "23505",
      constraint: "registrations_email_form_id_key",
      table: "registrations",
    });
    expect(entry).not.toHaveProperty("err");
    const text = logged();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("insert into");
    expect(text).not.toContain("0191aa00");
  });

  it("logs an unhandled DB error through the sanitizing serializer (no SQL, params or detail)", () => {
    process.env.NODE_ENV = "test";
    const cause = pgError(
      {
        code: "22P02",
        severity: "ERROR",
        detail: `value ${EMAIL}`,
        table: "registrations",
      },
      `invalid input syntax for type uuid: "${EMAIL}"`,
    );
    const err = new DrizzleQueryError(SQL, [EMAIL, "x"], cause);

    const { host, reply } = makeHost();
    new HttpExceptionFilter().catch(err, host);

    expect(reply.status).toHaveBeenCalledWith(500);
    const text = logged();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("insert into");
    const entry = JSON.parse(sink.lines[0]);
    expect(entry).toMatchObject({ msg: "Unhandled exception", code: "22P02", table: "registrations" });
    expect(entry.err.message).toContain("Failed query (SQL text and parameters redacted)");
    expect(entry.err).not.toHaveProperty("params");
    expect(entry.err).not.toHaveProperty("query");
    expect(entry.err).not.toHaveProperty("detail");
    // Non-production responses still never echo SQL, params or input values.
    const body = JSON.stringify(reply.send.mock.calls[0][0]);
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("insert into");
  });

  it("never echoes SQL or params in a non-production response for a code-less Drizzle error", () => {
    process.env.NODE_ENV = "test";
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const { host, reply } = makeHost();
    new HttpExceptionFilter().catch(new DrizzleQueryError(SQL, [EMAIL], cause), host);

    const body = JSON.stringify(reply.send.mock.calls[0][0]);
    expect(body).toContain("Failed query (SQL text and parameters redacted)");
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("insert into");
    expect(logged()).not.toContain(EMAIL);
    expect(logged()).not.toContain("insert into");
  });

  it("keeps non-database error messages in non-production responses", () => {
    process.env.NODE_ENV = "test";
    const { host, reply } = makeHost();
    new HttpExceptionFilter().catch(new Error("plain failure"), host);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "plain failure" }),
      }),
    );
  });
});

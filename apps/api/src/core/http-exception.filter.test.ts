import { createRequire } from "node:module";
import path from "node:path";
import type { ArgumentsHost } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { ServiceUnavailableException } from "@nestjs/common";
import { IntegrationError } from "@app/integrations";
import { AppException } from "./app-exception";
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

const nonProduction = { isProduction: false };
const production = { isProduction: true };

describe("HttpExceptionFilter — database errors are logged without PII", () => {
  beforeEach(() => {
    sink.lines.length = 0;
  });

  it("logs a constraint violation as { code, constraint, table } only", () => {
    const err = uniqueViolation();
    // Sanity: the raw error really embeds the SQL, the params and the email.
    expect(err.message).toContain(EMAIL);
    expect(err.message).toContain("insert into");

    const { host, reply } = makeHost();
    new HttpExceptionFilter(nonProduction).catch(err, host);

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
    new HttpExceptionFilter(nonProduction).catch(err, host);

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
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const { host, reply } = makeHost();
    new HttpExceptionFilter(nonProduction).catch(new DrizzleQueryError(SQL, [EMAIL], cause), host);

    const body = JSON.stringify(reply.send.mock.calls[0][0]);
    expect(body).toContain("Failed query (SQL text and parameters redacted)");
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("insert into");
    expect(logged()).not.toContain(EMAIL);
    expect(logged()).not.toContain("insert into");
  });

  it("keeps non-database error messages in non-production responses", () => {
    const { host, reply } = makeHost();
    new HttpExceptionFilter(nonProduction).catch(new Error("plain failure"), host);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "plain failure" }),
      }),
    );
  });

  it("hides unhandled error messages in production, and without injected config", () => {
    for (const filter of [new HttpExceptionFilter(production), new HttpExceptionFilter()]) {
      const { host, reply } = makeHost();
      filter.catch(new Error("plain failure"), host);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: { code: ErrorCodes.INTERNAL_ERROR, message: "Internal server error" },
        }),
      );
    }
  });
});

describe("HttpExceptionFilter — IntegrationError and 5xx HttpException", () => {
  beforeEach(() => {
    sink.lines.length = 0;
  });

  it("maps an IntegrationError to its own status, code and message (not a 500)", () => {
    const { host, reply } = makeHost("/api/events/e1/banner");
    const err = new IntegrationError(
      "Invalid image. Upload a valid image of at most 20 megapixels.",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
    new HttpExceptionFilter(production).catch(err, host);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_FILE_TYPE,
        message: "Invalid image. Upload a valid image of at most 20 megapixels.",
      },
      requestId: expect.any(String),
    });
    const entry = JSON.parse(sink.lines[0]!);
    expect(entry).toMatchObject({ level: 40, status: 400, code: ErrorCodes.INVALID_FILE_TYPE });
  });

  it("carries IntegrationError details and logs a 5xx one as an error", () => {
    const { host, reply } = makeHost();
    const err = new IntegrationError("Storage unavailable", 502, "STORAGE_UNAVAILABLE", {
      provider: "r2",
    });
    new HttpExceptionFilter(production).catch(err, host);

    expect(reply.status).toHaveBeenCalledWith(502);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { code: "STORAGE_UNAVAILABLE", message: "Storage unavailable", details: { provider: "r2" } },
      }),
    );
    const entry = JSON.parse(sink.lines[0]!);
    expect(entry).toMatchObject({ level: 50, msg: "Integration error", status: 502 });
  });

  it("does not treat a look-alike without a valid status as an IntegrationError", () => {
    const { host, reply } = makeHost();
    const fake = Object.assign(new Error("boom"), { name: "IntegrationError", status: 200, code: "X" });
    new HttpExceptionFilter(production).catch(fake, host);
    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it("logs a 5xx HttpException (previously silent) and keeps its envelope", () => {
    const { host, reply } = makeHost();
    new HttpExceptionFilter(production).catch(
      new AppException("SRV_5001", "Render failed", 500),
      host,
    );
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: { code: "SRV_5001", message: "Render failed" } }),
    );
    expect(JSON.parse(sink.lines[0]!)).toMatchObject({
      level: 50,
      msg: "Server error response",
      status: 500,
    });
  });

  it("logs a 503 at warn and a 4xx HttpException not at all", () => {
    const { host } = makeHost();
    const filter = new HttpExceptionFilter(production);
    filter.catch(new ServiceUnavailableException({ code: "BUSY", message: "Busy" }), host);
    filter.catch(new AppException(ErrorCodes.NOT_FOUND, "Not found", 404), host);
    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0]!)).toMatchObject({ level: 40, status: 503, code: "BUSY" });
  });
});

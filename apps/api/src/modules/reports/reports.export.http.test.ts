import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

// 3.7 through the real app (buildApp: auth guard, filter, CoreModule's
// ExportDownloads, the reports route): the registrations export streams with
// no Content-Length, admission is bounded (2 running + 4 queued, then 503
// EXPORT_BUSY), a client that leaves stops generation, a failure after the
// headers breaks the download, and shutdown drains or aborts exports.
// Token verification, the user/event lookups and the export rows are faked.

const EVENT_ID = "event-1";

vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserWithClientById: vi.fn(async () => ({
    id: "u1",
    email: "admin@example.com",
    name: "Admin",
    role: UserRole.CLIENT_ADMIN,
    clientId: "client-A",
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    client: {
      id: "client-A",
      name: "Client",
      logo: null,
      primaryColor: null,
      email: null,
      phone: null,
      active: true,
      enabledModules: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  })),
  getEventWithPricing: vi.fn(async (id: string) => ({ id, clientId: "client-A" })),
  withExportStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  getEventSlug: vi.fn(async () => ({ slug: "congres" })),
  getRegistrationFormDataKeys: vi.fn(async () => ["city"]),
  iterateRegistrationsForExport: vi.fn(),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));

import * as db from "@app/db";
import { buildApp } from "../../app.factory";
import { clearUserCache } from "../../core/auth/user-cache";
import { ShutdownCoordinator } from "../../core/shutdown";
import { ExportDownloads } from "../../core/exports/stream-download";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

function row(n: number) {
  return {
    id: `r-${n}`,
    email: `p${n}@example.test`,
    firstName: "Prénom",
    lastName: null,
    phone: null,
    paymentStatus: "PAID",
    paymentMethod: null,
    totalAmount: 100,
    paidAmount: 100,
    baseAmount: 100,
    accessAmount: 0,
    discountAmount: 0,
    sponsorshipCode: null,
    sponsorshipAmount: 0,
    submittedAt: new Date(Date.UTC(2026, 0, 1) - n * 1000),
    paidAt: null,
    formData: { city: "Tunis" },
  };
}

const page = (start: number, size: number) =>
  Array.from({ length: size }, (_, i) => row(start + i));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Every export's signal, and how many pages each has produced. */
let signals: AbortSignal[] = [];
let pagesServed = 0;

function serveFinite(pages: number, size = 3) {
  m.iterateRegistrationsForExport.mockImplementation(
    (_eventId: string, _filters: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return (async function* () {
        for (let p = 0; p < pages; p++) {
          pagesServed += 1;
          yield page(p * size, size);
        }
      })();
    },
  );
}

/** Each export yields one page, then waits for `gate` before finishing. */
function serveGated(gate: Promise<void>) {
  m.iterateRegistrationsForExport.mockImplementation(
    (_eventId: string, _filters: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return (async function* () {
        pagesServed += 1;
        yield page(0, 2);
        await gate;
        pagesServed += 1;
        yield page(2, 2);
      })();
    },
  );
}

/** Large pages forever, as fast as the consumer allows (checks its signal like the real iterator). */
function serveEndless() {
  m.iterateRegistrationsForExport.mockImplementation(
    (_eventId: string, _filters: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return (async function* () {
        for (let p = 0; ; p++) {
          options.signal.throwIfAborted();
          pagesServed += 1;
          yield page(p * 500, 500);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
    },
  );
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("registrations export streaming (real app, 3.7)", () => {
  let app: NestFastifyApplication | undefined;
  let base = "";

  beforeEach(async () => {
    clearUserCache();
    vi.clearAllMocks();
    signals = [];
    pagesServed = 0;
    app = await buildApp();
    app.useLogger(false);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const url = (format = "csv") => `${base}/api/events/${EVENT_ID}/reports/registrations?format=${format}`;
  const get = (format = "csv") => fetch(url(format), { headers: { Authorization: "Bearer token" } });
  const limiter = () => app!.get(ExportDownloads).limiter;

  it("streams the CSV with the legacy headers and no Content-Length", async () => {
    serveFinite(3);
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="congres-registrations-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBe("chunked");
    const body = Buffer.from(await response.arrayBuffer());
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const lines = body.toString("utf8").split("\r\n");
    expect(lines[0]).toMatch(/^\uFEFF"ID",.*"Paid At","city"$/);
    expect(lines).toHaveLength(1 + 9 + 1); // header, 3 pages x 3 rows, trailing CRLF
    expect(limiter().running).toBe(0);
  });

  it("runs 2 exports, queues 4, answers the 7th 503 EXPORT_BUSY + Retry-After, then serves the queue", async () => {
    const gate = deferred();
    serveGated(gate.promise);

    const pending = Array.from({ length: 6 }, () => get());
    await until(() => limiter().running === 2 && limiter().queued === 4);

    const refused = await get();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("10");
    expect(await refused.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.EXPORT_BUSY } });

    gate.resolve();
    const responses = await Promise.all(pending);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.text()).split("\r\n")).toHaveLength(1 + 4 + 1);
    }
    expect(limiter()).toMatchObject({ running: 0, queued: 0 });
  });

  it("answers a failed lookup with the JSON error and frees the slot", async () => {
    serveFinite(1);
    m.getEventSlug.mockResolvedValueOnce(null);

    const response = await get();

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.NOT_FOUND } });
    expect(limiter().running).toBe(0);
    expect(m.iterateRegistrationsForExport).not.toHaveBeenCalled();
  });

  it("stops generating when the client disconnects and frees the slot", async () => {
    serveEndless();
    await new Promise<void>((resolve, reject) => {
      const request = http.get(url("xlsx"), { headers: { Authorization: "Bearer token" } }, (response) => {
        expect(response.statusCode).toBe(200);
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      });
      request.on("error", (err) => {
        if (!request.destroyed) reject(err);
      });
    });

    await until(() => signals[0]?.aborted === true && limiter().running === 0);
    const served = pagesServed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pagesServed).toBe(served); // no page after the abort
  });

  it("breaks the download when generation fails after the headers (no silently truncated file)", async () => {
    m.iterateRegistrationsForExport.mockImplementation(() =>
      (async function* () {
        yield page(0, 500);
        throw new Error("database went away");
      })(),
    );

    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    await until(() => limiter().running === 0);
  });

  it("answers a failure before the first byte through the error filter (500 SRV_5001)", async () => {
    m.iterateRegistrationsForExport.mockImplementation(() =>
      (async function* () {
        yield* [];
        throw new Error("connection terminated");
      })(),
    );

    const response = await get("json");

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.INTERNAL_ERROR } });
    await until(() => limiter().running === 0);
  });

  it("while draining, refuses new exports with 503 SRV_5003", async () => {
    serveFinite(1);
    app!.get(ShutdownCoordinator).startDraining();

    const response = await get();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: ErrorCodes.SERVER_SHUTTING_DOWN } });
    expect(limiter().running).toBe(0);
  });

  it("at shutdown, lets an open export finish within the drain window", async () => {
    const gate = deferred();
    serveGated(gate.promise);
    const pending = get();
    await until(() => pagesServed === 1);

    const coordinator = app!.get(ShutdownCoordinator);
    coordinator.startDraining();
    expect(coordinator.drainStreams()).toBe(1);
    gate.resolve();

    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.text()).split("\r\n")).toHaveLength(1 + 4 + 1);
  });

  it("at shutdown, aborts an export still running when the drain window ends", async () => {
    const downloads = app!.get(ExportDownloads);
    (downloads as unknown as { shutdownDrainMs: number }).shutdownDrainMs = 0;
    serveEndless();
    const pending = get("json");
    await until(() => pagesServed > 0);

    app!.get(ShutdownCoordinator).drainStreams();

    const response = await pending;
    await expect(response.text()).rejects.toThrow();
    await until(() => signals[0]?.aborted === true && limiter().running === 0);
    expect(signals[0]!.reason).toMatchObject({ reason: "shutdown" });
  });
});

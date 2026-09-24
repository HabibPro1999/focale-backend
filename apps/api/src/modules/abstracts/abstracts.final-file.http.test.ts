import "reflect-metadata";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes } from "@app/contracts";

// 0.3 through the real app (buildApp: @fastify/multipart, guards, global
// filter). Only the DB lookups and storage IO are stubbed.
const db = vi.hoisted(() => ({
  findAbstractForFinalFile: vi.fn(),
  findAbstractForToken: vi.fn(),
  updateAbstractFinalFileTxn: vi.fn(),
  findEventClientId: vi.fn(),
  findClientModuleState: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));
const storage = vi.hoisted(() => ({ uploadPrivate: vi.fn(), delete: vi.fn() }));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: () => storage,
}));

import { buildApp } from "../../app.factory";
import {
  MAX_FINAL_FILE_SIZE,
  MULTIPART_OVERHEAD_BYTES,
} from "./abstracts.final-file.service";

const abstractId = "11111111-1111-4111-8111-111111111111";
const url = `/api/public/abstracts/${abstractId}/final-file`;
const token = "a".repeat(64);
const boundary = "----focale-final-file-test";
const multipartHeaders = {
  "content-type": `multipart/form-data; boundary=${boundary}`,
  "x-abstract-token": token,
};
const partHead = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="poster.pdf"\r\n` +
    "Content-Type: application/pdf\r\n\r\n",
);
const partTail = Buffer.from(`\r\n--${boundary}--\r\n`);
const pdf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n%%EOF");

function acceptedAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId: "event-1",
    editToken: token,
    status: "ACCEPTED",
    finalType: "POSTER",
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    themes: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    lastEditedAt: null,
    config: { finalFileUploadEnabled: true, finalFileDeadline: null },
    ...overrides,
  };
}

/** A lazily generated multipart body that counts how many bytes were pulled. */
function countingBody(fileBytes: number) {
  const pulled = { bytes: 0 };
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  let remaining = fileBytes;
  let sentHead = false;
  const stream = new Readable({
    read() {
      let next: Buffer | null;
      if (!sentHead) {
        sentHead = true;
        next = Buffer.concat([partHead, Buffer.from("%PDF-")]);
      } else if (remaining > 0) {
        next = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= next.length;
      } else if (remaining === 0) {
        remaining = -1;
        next = partTail;
      } else {
        next = null;
      }
      if (next) pulled.bytes += next.length;
      this.push(next);
    },
  });
  return { stream, pulled };
}

describe("POST /api/public/abstracts/:id/final-file (real app)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.findAbstractForFinalFile.mockResolvedValue(acceptedAbstract());
    db.findEventClientId.mockResolvedValue({ id: "event-1", clientId: "client-1" });
    db.findClientModuleState.mockResolvedValue({
      active: true,
      enabledModules: ["abstracts"],
    });
    db.updateAbstractFinalFileTxn.mockImplementation(
      async (_id: string, prepare: (row: unknown) => unknown) => {
        prepare(acceptedAbstract());
        return { previousKey: null };
      },
    );
    storage.uploadPrivate.mockImplementation(async (_b: Buffer, key: string) => key);
    db.findAbstractForToken.mockImplementation(async () =>
      acceptedAbstract({ finalFileKey: "stored", finalFileKind: "PDF" }),
    );
  });

  it("declared Content-Length over the limit → 413 FILE_TOO_LARGE envelope, no DB read", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      headers: {
        ...multipartHeaders,
        "content-length": String(MAX_FINAL_FILE_SIZE + MULTIPART_OVERHEAD_BYTES + 1),
      },
      payload: Buffer.concat([partHead, pdf, partTail]),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.FILE_TOO_LARGE },
    });
    expect(db.findAbstractForFinalFile).not.toHaveBeenCalled();
  });

  it("rejected by status → 409 before the (60MB, chunked) body is pulled", async () => {
    db.findAbstractForFinalFile.mockResolvedValue(acceptedAbstract({ status: "PENDING" }));
    const { stream, pulled } = countingBody(60 * 1024 * 1024);

    const res = await app.inject({ method: "POST", url, headers: multipartHeaders, payload: stream });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: ErrorCodes.INVALID_STATUS_TRANSITION },
    });
    expect(pulled.bytes).toBeLessThan(1024 * 1024);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it("chunked body past the multipart fileSize limit → 413 FILE_TOO_LARGE (not 500), no upload", async () => {
    const { stream } = countingBody(MAX_FINAL_FILE_SIZE + 1);

    const res = await app.inject({ method: "POST", url, headers: multipartHeaders, payload: stream });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: ErrorCodes.FILE_TOO_LARGE } });
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });

  it("a small valid PDF is uploaded and recorded (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      headers: multipartHeaders,
      payload: Buffer.concat([partHead, pdf, partTail]),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, data: { finalFile: { uploaded: true } } });
    expect(storage.uploadPrivate).toHaveBeenCalledTimes(1);
    expect(storage.uploadPrivate.mock.calls[0][0]).toEqual(pdf);
    expect(db.updateAbstractFinalFileTxn).toHaveBeenCalledTimes(1);
  });
});

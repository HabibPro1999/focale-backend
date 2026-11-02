import "reflect-metadata";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

// 3.1 through the real app (buildApp: multipart, guards, global filter): an
// image the shared decoder rejects (0.7) must surface as 400
// INVALID_FILE_TYPE on the banner and payment-proof uploads. Before 3.1 the
// filter did not know IntegrationError and both returned 500. compressImage /
// compressFile and IntegrationError are the real ones; only DB lookups, token
// verification and storage IO are stubbed.
const db = vi.hoisted(() => ({
  getUserWithClientById: vi.fn(),
  getEventWithPricing: vi.fn(),
  // The banner route's tenant scope guard (5.4b).
  getEventTenantScope: vi.fn(),
  getRegistrationEditToken: vi.fn(),
  findRegistrationWithFormEvent: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));
const storage = vi.hoisted(() => ({
  uploadPublic: vi.fn(),
  uploadPrivate: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "admin-1" })),
  getStorageProvider: () => storage,
}));

import { buildApp } from "../app.factory";
import { clearUserCache } from "./auth/user-cache";

const eventId = "11111111-1111-4111-8111-111111111111";
const registrationId = "22222222-2222-4222-8222-222222222222";
const editToken = "e".repeat(64);
const boundary = "----focale-integration-error-test";

/** A PNG header declaring 16384×16384 (268 MP): over the 20 MP decode limit. */
function decompressionBombPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16384, 0);
  ihdr.writeUInt32BE(16384, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function multipartPng(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\n` +
        "Content-Type: image/png\r\n\r\n",
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

const multipartHeaders = { "content-type": `multipart/form-data; boundary=${boundary}` };

const rejectedImage = {
  ok: false,
  error: {
    code: ErrorCodes.INVALID_FILE_TYPE,
    message: "Invalid image. Upload a valid image of at most 20 megapixels.",
  },
};

describe("IntegrationError through the global filter (real app)", () => {
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
    clearUserCache();
    db.getUserWithClientById.mockResolvedValue({
      id: "admin-1",
      email: "admin@example.com",
      name: "Admin",
      role: UserRole.SUPER_ADMIN,
      clientId: null,
      active: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      client: null,
    });
    db.getEventWithPricing.mockResolvedValue({
      id: eventId,
      clientId: "client-1",
      status: "OPEN",
      bannerUrl: null,
    });
    db.getEventTenantScope.mockResolvedValue({
      event: { id: eventId, clientId: "client-1", status: "OPEN", slug: "ev" },
      client: { id: "client-1", active: true, enabledModules: [] },
    });
    db.getRegistrationEditToken.mockResolvedValue({ editToken });
    db.findRegistrationWithFormEvent.mockResolvedValue({
      id: registrationId,
      eventId,
      paymentStatus: "PENDING",
      paymentProofUrl: null,
      event: {
        id: eventId,
        slug: "ev",
        clientId: "client-1",
        status: "OPEN",
        endDate: new Date(Date.now() + 86_400_000),
        client: { active: true, enabledModules: ["registrations", "pricing"] },
      },
    });
  });

  it("POST /api/events/:id/banner with an oversized image → 400 INVALID_FILE_TYPE, nothing stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/banner`,
      headers: { ...multipartHeaders, authorization: "Bearer admin-token" },
      payload: multipartPng(decompressionBombPng()),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject(rejectedImage);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("POST /api/public/registrations/:id/payment-proof with an oversized image → 400 INVALID_FILE_TYPE, nothing stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/public/registrations/${registrationId}/payment-proof`,
      headers: { ...multipartHeaders, "x-edit-token": editToken },
      payload: multipartPng(decompressionBombPng()),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject(rejectedImage);
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
  });
});

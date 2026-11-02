import "reflect-metadata";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";
vi.mock("@app/integrations", async (original) => ({ ...(await original<typeof import("@app/integrations")>()), verifyToken: vi.fn(async () => ({ uid: "u1" })) }));
vi.mock("@app/db", async (original) => ({ ...(await original<typeof import("@app/db")>()), getUserWithClientById: vi.fn(), getCertificateTemplateTenantScope: vi.fn() }));
import * as db from "@app/db";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { CertificatesController } from "./certificates.controller";
import { CertificatesService } from "./certificates.service";
const id = "11111111-1111-4111-8111-111111111111";
const testSendCertificate = vi.fn(async () => ({ success: true }));
let app: NestFastifyApplication;
beforeAll(async () => { app = await createTestApp({ controllers: [CertificatesController], providers: [{ provide: CertificatesService, useValue: { testSendCertificate } }] }); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  vi.clearAllMocks();
  authAs(UserRole.CLIENT_ADMIN, id);
  vi.mocked(db.getCertificateTemplateTenantScope).mockResolvedValue({
    certificateTemplate: { id }, event: { id, clientId: id, status: "OPEN", slug: "test" },
    client: { id, active: true, enabledModules: ["certificates", "emails"] },
  });
});
it("takes the recipient from authenticated identity and rejects recipient overrides", async () => {
  const url = `/api/events/certificates/${id}/test-send`;
  const headers = { authorization: "Bearer test" };
  expect((await app.inject({ method: "POST", url, headers, payload: { email: "other@example.test" } })).statusCode).toBe(400);
  expect(testSendCertificate).not.toHaveBeenCalled();
  expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(200);
  expect(testSendCertificate).toHaveBeenCalledWith(id, expect.objectContaining({ email: "u1@example.com" }));
});
it("refuses another tenant", async () => {
  const headers = authAs(UserRole.CLIENT_ADMIN, "22222222-2222-4222-8222-222222222222");
  expect((await app.inject({ method: "POST", url: `/api/events/certificates/${id}/test-send`, headers, payload: {} })).statusCode).toBe(403);
  expect(testSendCertificate).not.toHaveBeenCalled();
});

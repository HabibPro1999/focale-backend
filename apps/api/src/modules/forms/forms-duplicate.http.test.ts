import "reflect-metadata";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";
vi.mock("@app/integrations", async (original) => ({ ...(await original<typeof import("@app/integrations")>()), verifyToken: vi.fn(async () => ({ uid: "u1" })) }));
vi.mock("@app/db", async (original) => ({ ...(await original<typeof import("@app/db")>()), getUserWithClientById: vi.fn(), getFormTenantScope: vi.fn(), getEventTenantScope: vi.fn() }));
import * as db from "@app/db";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";
const id = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const duplicateForm = vi.fn(async () => ({ id: target }));
let app: NestFastifyApplication;
const scope = (clientId = id) => ({ event: { id: target, clientId, status: "OPEN" as const, slug: "test" }, client: { id: clientId, active: true, enabledModules: ["registrations"] } });
beforeAll(async () => { app = await createTestApp({ controllers: [FormsController], providers: [{ provide: FormsService, useValue: { duplicateForm, getFormById: async () => ({ id, type: "REGISTRATION" }) } }] }); });
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); authAs(UserRole.CLIENT_ADMIN, id); vi.mocked(db.getFormTenantScope).mockResolvedValue({ ...scope(), form: { id, type: "REGISTRATION" } }); });
it("checks the destination tenant before copying", async () => {
  vi.mocked(db.getEventTenantScope).mockResolvedValue(scope(target));
  expect((await app.inject({ method: "POST", url: `/api/forms/${id}/duplicate`, headers: { authorization: "Bearer test" }, payload: { targetEventId: target } })).statusCode).toBe(403);
  expect(duplicateForm).not.toHaveBeenCalled();
});
it("copies when both source and destination belong to the admin", async () => {
  vi.mocked(db.getEventTenantScope).mockResolvedValue(scope());
  expect((await app.inject({ method: "POST", url: `/api/forms/${id}/duplicate`, headers: { authorization: "Bearer test" }, payload: { targetEventId: target } })).statusCode).toBe(201);
  expect(duplicateForm).toHaveBeenCalledWith(id, { targetEventId: target });
});

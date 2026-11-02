import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { UserRole } from "@app/contracts";
import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { RegistrationsService } from "./registrations.service";
import { PlatformRegistrationsController } from "./platform-registrations.controller";

vi.mock("@app/integrations", async (original) => ({ ...(await original<typeof import("@app/integrations")>()), verifyToken: vi.fn(async () => ({ uid: "u1" })) }));
vi.mock("@app/db", async (original) => ({ ...(await original<typeof import("@app/db")>()), getUserWithClientById: vi.fn() }));

describe("platform registrations role boundary", () => {
  let app: NestFastifyApplication;
  const aggregate = vi.fn();
  const list = vi.fn(async () => ({ data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false } }));
  beforeAll(async () => { app = await createTestApp({ controllers: [PlatformRegistrationsController], providers: [{ provide: RegistrationsService, useValue: { platformAggregate: aggregate, platformList: list } }] }); });
  afterAll(async () => app.close());
  beforeEach(() => { aggregate.mockReset().mockResolvedValue({ total: 12, byPaymentStatus: [] }); });

  it("allows super admins and returns the contract", async () => {
    const response = await app.inject({ method: "GET", url: "/api/registrations/aggregate", headers: authAs(UserRole.SUPER_ADMIN) });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ total: 12, byPaymentStatus: [] });
  });
  it("refuses client admins before running a platform query", async () => {
    const response = await app.inject({ method: "GET", url: "/api/registrations/aggregate", headers: authAs(UserRole.CLIENT_ADMIN, "client") });
    expect(response.statusCode).toBe(403);
    expect(aggregate).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => {
    expect((await app.inject({ method: "GET", url: "/api/registrations/aggregate" })).statusCode).toBe(401);
    expect(aggregate).not.toHaveBeenCalled();
  });
  it("lists across events only for super admins", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/registrations", headers: authAs(UserRole.CLIENT_ADMIN, "client") });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "GET", url: "/api/registrations?role=SPEAKER", headers: authAs(UserRole.SUPER_ADMIN) });
    expect(allowed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ role: "SPEAKER" }));
  });

});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestApp } from "../helpers/test-app.js";
import type { AppInstance } from "../../src/shared/fastify.js";

describe("Health Check", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("healthy");
    expect(body.checks.database.status).toBe("healthy");
  });

  it("GET /health includes timestamp", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });
});

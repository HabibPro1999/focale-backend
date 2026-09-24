import { beforeEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => vi.fn());
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  getNetworkingVectorIndexHealth: health,
}));

import { HealthController } from "./health.controller";
import { getConfig } from "../../core/config";

const reply = () => ({ status: vi.fn().mockReturnThis() });

describe("GET /health/networking-vector-index", () => {
  beforeEach(() => health.mockReset());
  it("is 200 with the raw body while recommendations use the vector index", async () => {
    const body = { isHealthy: true, index: "present", recommendations: "vector", eventsAboveThreshold: 2, threshold: 5000 };
    health.mockResolvedValue(body);
    const target = reply();
    expect(await new HealthController().networkingVectorIndex(target as never)).toBe(body);
    expect(target.status).not.toHaveBeenCalled();
    expect(health).toHaveBeenCalledWith(getConfig().networking.embedding.model);
  });
  it("is 503 while a large event ranks with the deterministic fallback", async () => {
    const body = { isHealthy: false, index: "missing", recommendations: "deterministic-fallback", eventsAboveThreshold: 1, threshold: 5000 };
    health.mockResolvedValue(body);
    const target = reply();
    expect(await new HealthController().networkingVectorIndex(target as never)).toBe(body);
    expect(target.status).toHaveBeenCalledWith(503);
  });
});

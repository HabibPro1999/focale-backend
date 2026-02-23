import { prisma } from "@/database/client.js";
import type { AppInstance } from "@shared/fastify.js";

export async function healthRoutes(app: AppInstance): Promise<void> {
  // GET /health — detailed diagnostics
  app.get("/health", async (_request, reply) => {
    const startTime = Date.now();

    const checks: Record<
      string,
      {
        status: "healthy" | "unhealthy" | "degraded";
        latencyMs?: number;
        heapUsedMB?: number;
        error?: string;
      }
    > = {};

    // Database check with latency measurement
    try {
      const dbStart = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      checks.database = {
        status: "healthy",
        latencyMs: Date.now() - dbStart,
      };
    } catch (error) {
      checks.database = {
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }

    // Memory check
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const heapPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    checks.memory = {
      status: heapPercent > 90 ? "degraded" : "healthy",
      heapUsedMB,
    };

    // Determine overall status
    const hasUnhealthy = Object.values(checks).some(
      (c) => c.status === "unhealthy",
    );
    const hasDegraded = Object.values(checks).some(
      (c) => c.status === "degraded",
    );

    const overallStatus = hasUnhealthy
      ? "unhealthy"
      : hasDegraded
        ? "degraded"
        : "healthy";
    const statusCode = hasUnhealthy ? 503 : 200;

    return reply.status(statusCode).send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      responseTimeMs: Date.now() - startTime,
      memory: {
        heapUsedMB,
        heapTotalMB,
        heapPercent: Math.round(heapPercent),
      },
      checks,
      version: process.env.npm_package_version ?? "1.0.0",
    });
  });

  // GET /health/live — liveness probe (Kubernetes-style)
  app.get("/health/live", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  // GET /health/ready — readiness probe
  app.get("/health/ready", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: "ready" });
    } catch (err) {
      app.log.warn({ err }, "Health check: database unreachable");
      return reply.status(503).send({ status: "not ready" });
    }
  });
}

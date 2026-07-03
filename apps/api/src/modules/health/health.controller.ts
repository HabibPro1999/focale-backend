import { Controller, Get, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  getAbstractBookQueueHealth,
  getEmailQueueHealth,
  getOutboxHealth,
  pingDb,
} from "@app/db";
import type { FastifyReply } from "fastify";
import { SkipEnvelope } from "../../core/envelope.interceptor";

// Health probes are machine-consumed (load balancers, k8s, Render). They return
// the RAW legacy bodies with legacy status codes and are @SkipEnvelope: the
// success envelope wrapped 503 responses as { ok: true, ... } which broke the
// probe's unhealthy signal. @SkipThrottle so probes are never rate-limited.
@Controller()
@SkipThrottle()
export class HealthController {
  // Overall health — DB-gated (SELECT 1 via pingDb). Minimal public surface to
  // avoid information disclosure: no DB error detail leaks. 503 when unhealthy.
  @Get("health")
  @SkipEnvelope()
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const status = (await pingDb()) ? "healthy" : "unhealthy";
    if (status === "unhealthy") reply.status(503);
    return {
      status,
      timestamp: new Date().toISOString(),
      checks: { database: { status } },
    };
  }

  // Liveness (k8s-style) — pure "am I running", zero I/O, never fails.
  @Get("health/live")
  @SkipEnvelope()
  live() {
    return { status: "ok" };
  }

  // Readiness — same DB check as /health, terser body. 503 when not ready.
  @Get("health/ready")
  @SkipEnvelope()
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    if (await pingDb()) return { status: "ready" };
    reply.status(503);
    return { status: "not ready" };
  }

  // Operational queue probes: 200 when isHealthy, else 503; raw body either way.
  private async probe<T extends { isHealthy: boolean }>(
    reply: FastifyReply,
    check: () => Promise<T>,
  ): Promise<T> {
    const health = await check();
    if (!health.isHealthy) reply.status(503);
    return health;
  }

  @Get("health/email-queue")
  @SkipEnvelope()
  emailQueue(@Res({ passthrough: true }) reply: FastifyReply) {
    return this.probe(reply, getEmailQueueHealth);
  }

  @Get("health/abstract-book-jobs")
  @SkipEnvelope()
  abstractBookJobs(@Res({ passthrough: true }) reply: FastifyReply) {
    return this.probe(reply, getAbstractBookQueueHealth);
  }

  @Get("health/outbox")
  @SkipEnvelope()
  outbox(@Res({ passthrough: true }) reply: FastifyReply) {
    return this.probe(reply, getOutboxHealth);
  }
}

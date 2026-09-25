import { Controller, Get, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  getAbstractBookQueueHealth,
  getEmailQueueHealth,
  getOutboxHealth,
  getWorkerHealth,
  pingDb,
} from "@app/db";
import type { FastifyReply } from "fastify";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { ReadinessService } from "./readiness.service";

// Health probes are machine-consumed (load balancers, k8s, Render). They return
// the RAW legacy bodies with legacy status codes and are @SkipEnvelope: the
// success envelope wrapped 503 responses as { ok: true, ... } which broke the
// probe's unhealthy signal. @SkipThrottle so probes are never rate-limited.
@Controller()
@SkipThrottle()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

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

  // Readiness — not draining + cached DB ping + boot schema check. 503 with
  // the reasons when not ready, and 503 "draining" once shutdown starts.
  @Get("health/ready")
  @SkipEnvelope()
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const readiness = await this.readiness.check();
    if (readiness.ready) return { status: "ready" };
    reply.status(503);
    return readiness.status === "draining"
      ? { status: "draining" }
      : { status: readiness.status, reasons: readiness.reasons };
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

  // Worker heartbeats: an enabled worker beat < 60 s ago and no job running
  // past twice its timeout (worker_heartbeats, written every 15 s).
  @Get("health/worker")
  @SkipEnvelope()
  worker(@Res({ passthrough: true }) reply: FastifyReply) {
    return this.probe(reply, getWorkerHealth);
  }
}

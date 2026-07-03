import { Body, Controller, Get, Post, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  getAbstractBookQueueHealth,
  getEmailQueueHealth,
  getOutboxHealth,
  pingDb,
} from "@app/db";
import type { FastifyReply } from "fastify";
import { HealthService } from "./health.service";
import { EchoDto } from "./echo.dto";

@Controller()
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("health")
  getHealth() {
    return this.health.status();
  }

  @Get("ready")
  async getReady() {
    if (!process.env.DATABASE_URL) return { db: null };
    return { db: await pingDb() };
  }

  @Post("health/echo")
  echo(@Body() body: EchoDto) {
    return { msg: body.msg };
  }

  // Operational health: 200 when isHealthy, else 503 (legacy parity). The body
  // is unchanged either way and rides the standard success envelope; the
  // unhealthy signal is the HTTP status + isHealthy:false in the payload.
  @Get("health/email-queue")
  async emailQueue(@Res({ passthrough: true }) reply: FastifyReply) {
    const health = await getEmailQueueHealth();
    if (!health.isHealthy) reply.status(503);
    return health;
  }

  @Get("health/abstract-book-jobs")
  async abstractBookJobs(@Res({ passthrough: true }) reply: FastifyReply) {
    const health = await getAbstractBookQueueHealth();
    if (!health.isHealthy) reply.status(503);
    return health;
  }

  @Get("health/outbox")
  async outbox(@Res({ passthrough: true }) reply: FastifyReply) {
    const health = await getOutboxHealth();
    if (!health.isHealthy) reply.status(503);
    return health;
  }
}

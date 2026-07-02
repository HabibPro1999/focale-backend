import { Body, Controller, Get, Post } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { pingDb } from "@app/db";
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
}

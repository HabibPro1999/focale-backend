import { Injectable } from "@nestjs/common";

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  status(): { status: "ok"; uptimeSec: number } {
    return { status: "ok", uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000) };
  }
}

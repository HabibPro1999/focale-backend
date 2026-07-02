import { Injectable } from "@nestjs/common";
import { createLogger } from "@app/shared";
import type { Job } from "../job";

const log = createLogger({ name: "worker" });

@Injectable()
export class HeartbeatJob implements Job {
  readonly name = "heartbeat";
  readonly intervalMs = 30_000;

  async run(): Promise<void> {
    log.info({ ts: new Date().toISOString() }, "heartbeat");
  }
}

import { Injectable } from "@nestjs/common";
import { pingDb, type SchemaCheckResult } from "@app/db";
import { ShutdownCoordinator } from "../../core/shutdown";

/** Readiness probes can be frequent; one database ping serves them for this long. */
export const READINESS_PING_CACHE_MS = 5_000;

export type SchemaState = "current" | "stale" | "unchecked";

export interface Readiness {
  ready: boolean;
  status: "ready" | "draining" | "not ready";
  reasons: string[];
}

/**
 * /health/ready: not draining + a cached database ping + the boot-time schema
 * check. main.ts records the MIGRATIONS_CHECK result after boot; without one
 * (tests, MIGRATIONS_CHECK=off) the schema part is "unchecked" and passes.
 */
@Injectable()
export class ReadinessService {
  private schema: SchemaState = "unchecked";
  private ping: { ok: boolean; at: number } | undefined;
  private pending: Promise<boolean> | undefined;

  constructor(private readonly lifecycle: ShutdownCoordinator) {}

  recordSchemaCheck(result: SchemaCheckResult): void {
    this.schema = result.skipped ? "unchecked" : result.errors.length ? "stale" : "current";
  }

  get schemaState(): SchemaState {
    return this.schema;
  }

  async check(): Promise<Readiness> {
    if (this.lifecycle.draining) return { ready: false, status: "draining", reasons: ["draining for shutdown"] };
    const reasons: string[] = [];
    if (!(await this.databaseReachable())) reasons.push("database unreachable");
    if (this.schema === "stale") reasons.push("database schema is not current (see the boot MIGRATIONS_CHECK log)");
    return reasons.length
      ? { ready: false, status: "not ready", reasons }
      : { ready: true, status: "ready", reasons };
  }

  private async databaseReachable(): Promise<boolean> {
    const now = Date.now();
    if (this.ping && now - this.ping.at < READINESS_PING_CACHE_MS) return this.ping.ok;
    this.pending ??= pingDb()
      .then((ok) => {
        this.ping = { ok, at: Date.now() };
        return ok;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

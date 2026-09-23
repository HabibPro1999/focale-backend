import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { createNetworkingScaleFixture } from "../../../../../packages/db/tests/helpers/networking-fixture";
import { explainNetworkingDiscovery } from "@app/db";
import { NetworkingService } from "./networking.service";
import { networkingHash } from "./networking.security";
const enabled =
  process.env.NETWORKING_PERFORMANCE === "1" &&
  process.env.ALLOW_DB_TESTS === "1" &&
  !!process.env.TEST_DATABASE_URL;
const measure = async (run: () => Promise<unknown>) => {
  for (let i = 0; i < 3; i++) await run();
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: Number(samples[7].toFixed(2)),
    p95Ms: Number(samples[14].toFixed(2)),
    maxMs: Number(samples[14].toFixed(2)),
    samples: 15,
  };
};
describe.runIf(enabled)("networking isolated event-scale benchmark", () => {
  it("records real authenticated read latency at 2000 and 10000 profiles", async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !/(test|ci)/i.test(url.pathname)
    )
      throw new Error("A local disposable test database is required");
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NETWORKING_TOKEN_SECRET =
      "networking-performance-local-secret-32-characters";
    const service = new NetworkingService();
    const results = [];
    let app: NestFastifyApplication | undefined;
    if (process.env.NETWORKING_PERFORMANCE_HTTP === "1") {
      const [
        { Module },
        { NestFactory },
        { FastifyAdapter },
        { CoreModule },
        { NetworkingModule },
      ] = await Promise.all([
        import("@nestjs/common"),
        import("@nestjs/core"),
        import("@nestjs/platform-fastify"),
        import("../../core/core.module.js"),
        import("./networking.module.js"),
      ]);
      class PerformanceModule {}
      Module({ imports: [CoreModule, NetworkingModule] })(PerformanceModule);
      app = await NestFactory.create<NestFastifyApplication>(
        PerformanceModule,
        new FastifyAdapter({ logger: false }),
        { logger: false },
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    }

    for (const size of (
      process.env.NETWORKING_PERFORMANCE_SIZES ?? "2000,10000"
    )
      .split(",")
      .map(Number)) {
      const fixture = await createNetworkingScaleFixture(size, networkingHash);
      try {
        if (process.env.NETWORKING_PERFORMANCE_EXPLAIN === "1")
          await writeFile(
            `/tmp/focale-networking-plan-${size}.json`,
            JSON.stringify(
              await explainNetworkingDiscovery(
                fixture.event.id,
                fixture.actorId,
                fixture.config.eligiblePaymentStatuses,
                { excludeInteracted: true },
              ),
              null,
              2,
            ),
          );
        const ctx = await service.participant(
          fixture.event.slug,
          `Bearer ${fixture.token}`,
        );
        const plain = await service.discover(ctx, {
          limit: 30,
          excludeInteracted: true,
        });
        expect(plain.items).toHaveLength(30);
        const measureRead = (
          query: Parameters<NetworkingService["discover"]>[1],
        ) =>
          measure(async () =>
            service.discover(
              await service.participant(
                fixture.event.slug,
                `Bearer ${fixture.token}`,
              ),
              { ...query, excludeInteracted: true },
            ),
          );
        const httpRead = async (parameters: Record<string, string>) => {
          const response = await app!
            .getHttpAdapter()
            .getInstance()
            .inject({
              method: "GET",
              url: `/api/networking/${fixture.event.slug}/profiles?${new URLSearchParams(parameters)}`,
              headers: { authorization: `Bearer ${fixture.token}` },
            });
          if (response.statusCode !== 200)
            throw new Error(
              `Benchmark HTTP ${response.statusCode}: ${response.body}`,
            );
        };
        const http = app
          ? {
              plain: await measure(() => httpRead({ limit: "30" })),
              filtered: await measure(() =>
                httpRead({ limit: "30", sectors: "Finance", city: "Tunis" }),
              ),
              relevance: await measure(() =>
                httpRead({ limit: "30", q: "Mohammed", sort: "recommended" }),
              ),
            }
          : undefined;
        results.push({
          size,
          http,
          eligible: plain.total,
          plain: await measureRead({ limit: 30 }),
          filtered: await measureRead({
            limit: 30,
            sectors: ["Finance"],
            city: "Tunis",
          }),
          phonetic: await measureRead({ limit: 30, q: "Mohammed" }),
        });
      } finally {
        await fixture.cleanup();
      }
    }
    await app?.close();
    const report = {
      label: process.env.NETWORKING_PERFORMANCE_LABEL ?? "current",
      measuredAt: new Date().toISOString(),
      conditions:
        "Local PostgreSQL, sequential requests, service authentication plus discovery; HTTP measurements, when present, use actual Nest/Fastify inject incl guards/DTO/envelope/JSON with no TCP/browser hop; no semantic model calls; 3 warmups/15 measured reads per variant",
      results,
    };
    console.log(JSON.stringify(report, null, 2));
    await writeFile(
      `/tmp/focale-networking-performance-${report.label}.json`,
      JSON.stringify(report, null, 2),
    );
  }, 180000);
});

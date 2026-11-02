import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// 3.7 opt-in load run: the modular workbook for 10,000 registrations x 60
// columns through the real streaming builder (__testing__/export-load.ts),
// compiled with tsc and run on plain node with NODE_ENV=production in a child
// process, so the numbers are those of a production-like process rather than
// of a vitest worker (~375 MB on its own). Pass, for a fast client and a
// 4 MB/s one (backpressure): peak RSS < 300 MB and event-loop delay < 150 ms.
// Needs the workspace packages built (`pnpm build`).
//
//   EXPORT_PERFORMANCE=1 pnpm --filter @app/api exec vitest run \
//     --config vitest.perf.config.ts src/modules/reports/registrations-export.perf.test.ts
//
// EXPORT_PERFORMANCE=legacy also runs the pre-3.7 in-memory builder, for
// comparison only (no assertion: it exceeds both limits).

const mode = process.env.EXPORT_PERFORMANCE;
const MAX_RSS_MB = 300;
const MAX_DELAY_MS = 150;
const API_ROOT = resolve(__dirname, "../../..");
const RUNNER = resolve(__dirname, "__testing__/export-load.ts");

interface LoadResult {
  mode: string;
  bytes: number;
  peakRssMb: number;
  maxDelayMs: number;
  [key: string]: unknown;
}

const exec = promisify(execFile);

describe.runIf(mode === "1" || mode === "legacy")("registrations export load (3.7, opt-in)", () => {
  let outDir = "";
  let runnerJs = "";

  beforeAll(async () => {
    if (!existsSync(resolve(API_ROOT, "../../packages/db/dist/index.js"))) {
      throw new Error("Build the workspace packages first (pnpm build)");
    }
    outDir = await mkdtemp(join(tmpdir(), "focale-export-load-"));
    const tsconfig = join(outDir, "tsconfig.json");
    await writeFile(
      tsconfig,
      JSON.stringify({
        extends: join(API_ROOT, "tsconfig.json"),
        compilerOptions: {
          noEmit: false,
          outDir: join(outDir, "out"),
          rootDir: join(API_ROOT, "src"),
          customConditions: [],
          incremental: false,
          types: ["node"],
          typeRoots: [join(API_ROOT, "node_modules/@types")],
        },
        include: [],
        files: [RUNNER],
      }),
    );
    await exec(process.execPath, [join(API_ROOT, "node_modules/typescript/bin/tsc"), "-p", tsconfig], {
      cwd: API_ROOT,
    });
    runnerJs = join(outDir, "out/modules/reports/__testing__/export-load.js");
  }, 120_000);

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<LoadResult> {
    const { stdout } = await exec(process.execPath, ["--expose-gc", runnerJs, ...args], {
      cwd: API_ROOT,
      env: { ...process.env, NODE_ENV: "production", NODE_PATH: join(API_ROOT, "node_modules") },
      maxBuffer: 1024 * 1024,
      timeout: 240_000,
    });
    const result = JSON.parse(stdout.trim().split("\n").pop()!) as LoadResult;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  it(
    `streams 10000 x 60 under ${MAX_RSS_MB} MB RSS with event-loop delay under ${MAX_DELAY_MS} ms`,
    async () => {
      if (mode === "legacy") await run("legacy");
      for (const args of [["streamed"], ["streamed", String(4 * 1024 * 1024)]]) {
        const result = await run(...args);
        expect(result.bytes).toBeGreaterThan(1_000_000);
        expect(result.peakRssMb).toBeLessThan(MAX_RSS_MB);
        expect(result.maxDelayMs).toBeLessThan(MAX_DELAY_MS);
      }
    },
    600_000,
  );
});

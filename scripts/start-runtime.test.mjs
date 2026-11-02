import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../start-runtime.mjs", import.meta.url));

async function runtime(t, worker, { env = {}, expectReady = 2 } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "focale-runtime-"));
  // "ready" is printed only after the SIGTERM handler is installed: the tests
  // signal as soon as they see it, and an earlier "ready" raced the handler.
  const idle = `const fs=require('node:fs'); const app=process.env.APP_NAME;
    fs.writeFileSync('started-'+app,'yes');
    process.on('SIGTERM',()=>{fs.writeFileSync('stopped-'+app,'yes');process.exit(0)});
    setInterval(()=>{},1000);
    console.log('ready');`;
  for (const app of ["api", "worker"]) {
    await mkdir(join(cwd, "apps", app, "dist"), { recursive: true });
    await writeFile(join(cwd, "apps", app, "dist", "main.js"),
      `process.env.APP_NAME='${app}';` + (app === "worker" && worker ? worker : idle));
  }
  const child = spawn(process.execPath, [entry], {
    cwd, env: { ...process.env, APP: "all", RUN_WORKERS: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on("close", (code, signal) => resolve({code, signal})));
  const ready = new Promise(resolve => {
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if ((stdout.match(/ready/g) || []).length === expectReady) resolve();
    });
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
    await rm(cwd, { recursive: true, force: true });
  });
  return { child, cwd, ready, closed, output: () => ({ stdout, stderr }) };
}

test("terminates both applications cleanly on service shutdown", { timeout: 5000 }, async t => {
  const run = await runtime(t);
  await run.ready;
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, { code: 0, signal: null });
  for (const app of ["api", "worker"])
    assert.equal(await readFile(join(run.cwd, "stopped-" + app), "utf8"), "yes");
});

test("fails the service and stops the API if the worker fails", { timeout: 5000 }, async t => {
  const run = await runtime(t, "console.log('ready'); setTimeout(()=>process.exit(7),200);");
  assert.deepEqual(await run.closed, { code: 7, signal: null });
  assert.equal(await readFile(join(run.cwd, "stopped-api"), "utf8"), "yes");
});

test("does not leave a healthy API behind when the worker exits without running", { timeout: 5000 }, async t => {
  const run = await runtime(t, "console.log('ready'); setTimeout(()=>process.exit(0),200);");
  assert.deepEqual(await run.closed, { code: 1, signal: null });
  assert.equal(await readFile(join(run.cwd, "stopped-api"), "utf8"), "yes");
});

test("logs every child exit during a normal shutdown", { timeout: 5000 }, async t => {
  const run = await runtime(t);
  await run.ready;
  run.child.kill("SIGTERM");
  await run.closed;
  const { stdout } = run.output();
  assert.match(stdout, /api exited/);
  assert.match(stdout, /worker exited/);
});

test("APP=all with RUN_WORKERS=false starts only the API", { timeout: 5000 }, async t => {
  const run = await runtime(t, undefined, { env: { RUN_WORKERS: "false" }, expectReady: 1 });
  await run.ready;
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(readFile(join(run.cwd, "started-worker"), "utf8"));
  assert.match(run.output().stdout, /starting the API only/);
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, { code: 0, signal: null });
  assert.equal(await readFile(join(run.cwd, "stopped-api"), "utf8"), "yes");
});

test("SIGKILLs a child still running SHUTDOWN_GRACE_MS + 3 s after SIGTERM", { timeout: 10000 }, async t => {
  const stubborn = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log('ready');";
  const run = await runtime(t, stubborn, { env: { SHUTDOWN_GRACE_MS: "200" } });
  await run.ready;
  const startedAt = Date.now();
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, { code: 0, signal: null });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 3100 && elapsed < 6000, `escalated after ${elapsed} ms`);
  const { stdout, stderr } = run.output();
  assert.match(stderr, /worker still running 3200 ms after SIGTERM; sending SIGKILL/);
  assert.match(stdout, /worker exited \{ code: null, signal: 'SIGKILL' \}/);
  assert.equal(await readFile(join(run.cwd, "stopped-api"), "utf8"), "yes");
});

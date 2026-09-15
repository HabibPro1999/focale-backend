import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../start-runtime.mjs", import.meta.url));

async function runtime(t, worker) {
  const cwd = await mkdtemp(join(tmpdir(), "focale-runtime-"));
  const idle = `const fs=require('node:fs'); const app=process.env.APP_NAME;
    console.log('ready');
    process.on('SIGTERM',()=>{fs.writeFileSync('stopped-'+app,'yes');process.exit(0)});
    setInterval(()=>{},1000);`;
  for (const app of ["api", "worker"]) {
    await mkdir(join(cwd, "apps", app, "dist"), { recursive: true });
    await writeFile(join(cwd, "apps", app, "dist", "main.js"),
      `process.env.APP_NAME='${app}';` + (app === "worker" && worker ? worker : idle));
  }
  const child = spawn(process.execPath, [entry], {
    cwd, env: { ...process.env, APP: "all" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.on("close", (code, signal) => resolve({code, signal})));
  const ready = new Promise(resolve => {
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if ((output.match(/ready/g) || []).length === 2) resolve(); });
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
    await rm(cwd, { recursive: true, force: true });
  });
  return { child, cwd, ready, closed };
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

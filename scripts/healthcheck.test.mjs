import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../healthcheck.mjs";

test("worker: passes on a fresh heartbeat file, fails when stale or missing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "focale-healthcheck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "worker.heartbeat");
  const env = { APP: "worker", WORKER_HEARTBEAT_FILE: file };

  assert.deepEqual(await check(env), { ok: false, reason: "worker heartbeat file missing" });
  await writeFile(file, "{}");
  assert.deepEqual(await check(env), { ok: true });
  const old = new Date(Date.now() - 61_000);
  await utimes(file, old, old);
  const stale = await check(env);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /heartbeat is 6\d s old/);
});

for (const app of ["api", "all"]) {
  test(`${app}: follows GET /health/live`, async t => {
    let status = 200;
    const server = createServer((req, res) => {
      res.statusCode = req.url === "/health/live" ? status : 404;
      res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const env = { APP: app, PORT: String(server.address().port) };

    assert.deepEqual(await check(env), { ok: true });
    status = 503;
    assert.deepEqual(await check(env), { ok: false, reason: "/health/live returned 503" });
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(await check(env), { ok: false, reason: "/health/live unreachable" });
  });
}

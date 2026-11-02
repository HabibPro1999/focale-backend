import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { changedPaths, planForPaths, requiredCheckErrors } from "./ci-plan.mjs";

const full = planForPaths([], true);
const jobCount = plan => Number(plan.static) + Number(plan.image) + plan.matrix.include.length;

test("docs-only and unchanged trees skip every expensive job", () => {
  for (const paths of [[], ["README.md", "FRONTEND_FOLLOWUP_5_2.md", "docs/networking/README.md", "docs/diagram.svg"]]) {
    assert.equal(jobCount(planForPaths(paths)), 0);
  }
});

test("application and query changes keep DB/concurrency on both engines", () => {
  for (const path of ["apps/api/src/modules/registrations/payments.ts", "apps/worker/src/jobs/outbox.ts", "packages/integrations/src/email/send.ts", "packages/db/src/queries/registrations.ts", "packages/db/src/settlement/invariants.ts"]) {
    const plan = planForPaths([path]);
    assert.equal(jobCount(plan), 9, path);
    assert.equal(plan.image, false);
    assert.equal(plan.migration, false);
    for (const engine of ["postgres", "cockroach"]) {
      assert.ok(plan.matrix.include.some(job => job.engine === engine && job.command === "test:db"));
      assert.ok(plan.matrix.include.some(job => job.engine === engine && job.command === "test:concurrency"));
    }
  }
});

test("test-only edits select their tier; mixed changes take the union", () => {
  assert.equal(jobCount(planForPaths(["apps/api/src/a.test.ts"])), 1);
  assert.equal(jobCount(planForPaths(["apps/api/src/a.db.test.ts"])), 6);
  assert.equal(jobCount(planForPaths(["apps/api/src/a.concurrency.test.ts"])), 4);
  assert.equal(jobCount(planForPaths(["packages/db/tests/migration/a.migration.test.ts"])), 3);
  const mixed = planForPaths(["README.md", "apps/api/src/a.db.test.ts", "apps/api/src/a.concurrency.test.ts"]);
  assert.equal(jobCount(mixed), 9);
});

test("migrations, dependencies, shared layers, CI and unknown paths require the full suite", () => {
  for (const path of [
    ".github/workflows/ci.yml", "scripts/ci-plan.mjs", "scripts/ci-plan.test.mjs", "Dockerfile", ".dockerignore",
    "start-runtime.mjs", "healthcheck.mjs", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json",
    "apps/api/package.json", "apps/api/tsconfig.build.json", "packages/db/migrations/0036_new.sql",
    "packages/db/src/migrator/runner.ts", "packages/db/src/schema/registrations.ts", "packages/db/src/client.ts",
    "packages/db/src/testing/database.ts", "packages/db/tests/helpers/factories.ts", "packages/db/vitest.shared.ts",
    "packages/shared/src/settlement.ts", "packages/contracts/src/app-config.ts", "tests/unit/setup.ts",
    "packages/new-package/src/thing.ts", "docs/new-tool.mjs", "unknown.file",
  ]) assert.deepEqual(planForPaths([path]), full, path);
  assert.equal(jobCount(full), 12);
  assert.equal(new Set(full.matrix.include.map(job => `${job.engine}/${job.command}/${job.shard}`)).size, 10);
});

test("manual full validation overrides docs-only selection", () => {
  assert.deepEqual(planForPaths(["README.md"], true), full);
});

test("required gate refuses failure, cancellation, missing outputs and unexpected skips", () => {
  const selected = { static: true, db: true, image: false };
  const good = { plan: "success", static: "success", db: "success", image: "skipped" };
  assert.deepEqual(requiredCheckErrors(selected, good), []);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.notEqual(requiredCheckErrors(selected, { ...good, db: result }).length, 0);
    assert.notEqual(requiredCheckErrors(selected, { ...good, plan: result }).length, 0);
  }
  assert.notEqual(requiredCheckErrors({}, good).length, 0);
  assert.deepEqual(requiredCheckErrors({ static: false, db: false, image: false }, {
    plan: "success", static: "skipped", db: "skipped", image: "skipped",
  }), []);
});

test("PR diff covers the entire branch, push diff covers the event, and renames cannot hide code", t => {
  const cwd = mkdtempSync(join(tmpdir(), "focale-ci-diff-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "CI Test");
  git("config", "user.email", "ci@example.test");
  git("config", "commit.gpgsign", "false");
  const commit = () => { git("add", "."); git("commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  mkdirSync(join(cwd, "apps/api/src"), { recursive: true });
  writeFileSync(join(cwd, "apps/api/src/old.ts"), "old code\n");
  const base = commit();
  writeFileSync(join(cwd, "apps/api/src/new\nname.ts"), "new code\n");
  const middle = commit();
  git("mv", "apps/api/src/old.ts", "README.md");
  const head = commit();
  const paths = changedPaths("pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }, cwd);
  assert.deepEqual(paths.sort(), ["README.md", "apps/api/src/new\nname.ts", "apps/api/src/old.ts"].sort());
  assert.equal(planForPaths(paths).db, true);
  assert.deepEqual(changedPaths("push", { before: middle, after: head }, cwd).sort(), ["README.md", "apps/api/src/old.ts"].sort());
  assert.throws(() => changedPaths("push", { before: "0".repeat(40), after: head }, cwd));
  assert.throws(() => changedPaths("push", { before: "--help", after: head }, cwd));
  assert.throws(() => changedPaths("workflow_dispatch", {}, cwd));
});

test("CLI falls back to full validation when history is missing", t => {
  const cwd = mkdtempSync(join(tmpdir(), "focale-ci-fallback-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const event = join(cwd, "event.json");
  const output = join(cwd, "output");
  writeFileSync(event, JSON.stringify({ before: "a".repeat(40), after: "b".repeat(40) }));
  const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "ci-plan.mjs")], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  const outputs = readFileSync(output, "utf8");
  assert.match(outputs, /static=true\nimage=true\ndb=true\n/);
  assert.equal(JSON.parse(outputs.split("matrix=")[1]).include.length, 10);
});

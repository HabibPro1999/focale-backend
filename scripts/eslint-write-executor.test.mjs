import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import path from "node:path";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { focalePlugin, WORKSPACE_ROOT } from "./eslint-package-boundaries.mjs";
import { WRITE_EXECUTOR_ALLOW_LIST } from "../eslint.config.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = after;

// Type-aware: every case is linted as fixtures/explicit-write-executor/file.ts,
// next to executor.ts (the DbExecutor/getDb/sql stand-ins and a write and a
// read in another file).
const FIXTURE = path.join(WORKSPACE_ROOT, "scripts/fixtures/explicit-write-executor");
const header = `import { auditLogs, getDb, insertAudit, readAudit, sql, type DbExecutor } from "./executor";\n`;
const valid = (code) => ({ filename: path.join(FIXTURE, "file.ts"), code: header + code });
const invalid = (code, name, reason, param = "exec", kind = "default") => ({
  ...valid(code),
  errors: [{ messageId: "defaulted", data: { name, reason, param, kind } }],
});

new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: FIXTURE },
  },
}).run("focale/explicit-write-executor", focalePlugin.rules["explicit-write-executor"], {
  valid: [
    // Reads keep their default.
    valid(`export async function listAudits(exec: DbExecutor = getDb()) { return exec.select().from(auditLogs); }`),
    valid(`export async function viaRead(exec: DbExecutor = getDb()) { return readAudit(exec); }`),
    // A row lock alone is not a write.
    valid(`export async function lockAudit(exec: DbExecutor = getDb()) { return exec.select().from(auditLogs).for("update"); }`),
    valid(
      "export async function lockRaw(exec: DbExecutor = getDb()) {\n" +
        '  await exec.execute(sql`SELECT id FROM "audit_logs" FOR UPDATE SKIP LOCKED`);\n' +
        '  return exec.execute(sql`SELECT id FROM "audit_logs" FOR NO KEY UPDATE OF "audit_logs"`);\n' +
        "}",
    ),
    // Writes with an explicit executor; other parameters may have defaults.
    valid(`export async function addAudit(v: unknown, exec: DbExecutor) { await exec.insert(auditLogs).values(v); }`),
    valid(
      "export async function prune(exec: DbExecutor, retentionMs = 1000) {\n" +
        '  await exec.execute(sql`DELETE FROM "audit_logs" WHERE age > ${retentionMs}`);\n' +
        "}",
    ),
    // insert/update/delete on something that is not an executor.
    valid(
      "export async function cached(exec: DbExecutor = getDb()) {\n" +
        "  const seen = new Map<string, number>();\n" +
        '  seen.delete("a");\n' +
        "  return exec.select();\n" +
        "}",
    ),
  ],
  invalid: [
    invalid(
      `export async function addAudit(v: unknown, exec: DbExecutor = getDb()) { await exec.insert(auditLogs).values(v); }`,
      "addAudit",
      "INSERT",
    ),
    invalid(`export const touch = async (exec: DbExecutor = getDb()) => { await exec.update(auditLogs).set({}); };`, "touch", "UPDATE"),
    invalid(
      `export const store = { async purge(db: DbExecutor = getDb()) { await db.delete(auditLogs).where(true); } };`,
      "purge",
      "DELETE",
      "db",
    ),
    invalid(
      'export async function bump(exec: DbExecutor = getDb()) { await exec.execute(sql`UPDATE "audit_logs" SET n = n + 1`); }',
      "bump",
      "raw SQL write",
    ),
    invalid(
      'export async function wipe(exec: DbExecutor = getDb()) { await exec.execute(sql.raw("DELETE FROM audit_logs")); }',
      "wipe",
      "raw SQL write",
    ),
    // Through a call, in the same file or another one.
    invalid(
      "async function write(exec: DbExecutor) { await exec.insert(auditLogs).values({}); }\n" +
        "export async function outer(exec: DbExecutor = getDb()) { await write(exec); }",
      "outer",
      "calls write",
    ),
    invalid(
      `export async function audit(v: unknown, exec: DbExecutor = getDb()) { await insertAudit(v, exec); }`,
      "audit",
      "calls insertAudit",
    ),
    // An optional executor is a default by another name.
    invalid(
      `export async function maybe(v: unknown, exec?: DbExecutor) { await (exec ?? getDb()).insert(auditLogs).values(v); }`,
      "maybe",
      "INSERT",
      "exec",
      "optional marker",
    ),
    // Writing through the pool still makes it a write function.
    invalid(
      `export async function sneaky(exec: DbExecutor = getDb()) { await getDb().insert(auditLogs).values({}); return exec.select(); }`,
      "sneaky",
      "INSERT",
    ),
    // Nested closures count.
    invalid(
      `export function makeStore(exec: DbExecutor = getDb()) { return { add: (v: unknown) => exec.insert(auditLogs).values(v) }; }`,
      "makeStore",
      "INSERT",
    ),
  ],
});

test("the rule is an error on packages/db/src, except the 5.1b allow-list", async () => {
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });
  const severity = async (file) => {
    const setting = (await eslint.calculateConfigForFile(path.join(WORKSPACE_ROOT, file))).rules["focale/explicit-write-executor"];
    return Array.isArray(setting) ? setting[0] : setting;
  };
  for (const file of ["packages/db/src/queries/access.ts", "packages/db/src/outbox/outbox.ts", "packages/db/src/queries/registrations.ts"]) {
    assert.equal(await severity(file), 2, file);
  }
  for (const file of ["packages/db/src/queries/networking.ts", "packages/db/src/queries/networking-store.ts"]) {
    assert.equal(await severity(file), undefined, file);
  }
  assert.equal(await severity("apps/api/src/main.ts"), undefined);
});

test("every allow-list entry still matches a file", () => {
  for (const pattern of WRITE_EXECUTOR_ALLOW_LIST) {
    assert.ok(globSync(pattern, { cwd: WORKSPACE_ROOT }).length > 0, pattern);
  }
});

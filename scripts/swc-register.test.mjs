import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const register = fileURLToPath(new URL("./swc-register.cjs", import.meta.url));

/** Runs `source` as a .ts entry point through the register and returns stdout/stderr. */
function runTs(source) {
  const dir = mkdtempSync(join(tmpdir(), "swc-register-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, source);
    try {
      const stdout = execFileSync(process.execPath, ["-r", register, entry], { encoding: "utf8", stdio: "pipe" });
      return { ok: true, stdout, entry };
    } catch (error) {
      return { ok: false, stdout: error.stdout, stderr: error.stderr, entry };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("emits design:paramtypes for constructor injection and keeps class names", () => {
  const result = runTs(`
    const recorded: Array<[string, unknown]> = [];
    Object.assign(Reflect, {
      metadata: (key: string, value: unknown) => () => { recorded.push([key, value]); },
    });
    function Injectable(): ClassDecorator { return () => undefined; }
    class Dependency {}
    @Injectable()
    class Service { constructor(readonly dependency: Dependency) {} }
    const paramtypes = recorded.find(([key]) => key === "design:paramtypes")?.[1];
    console.log(JSON.stringify({
      name: Service.name,
      injectsDependency: Array.isArray(paramtypes) && paramtypes[0] === Dependency,
    }));
  `);
  assert.ok(result.ok, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "Service", injectsDependency: true });
});

test("never loads the typescript package", () => {
  const result = runTs(`
    const loaded = Object.keys(require.cache).filter((file) => /[\\\\/]typescript[\\\\/]/.test(file));
    console.log(JSON.stringify(loaded));
  `);
  assert.ok(result.ok, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("maps stack traces to the TypeScript source line", () => {
  const result = runTs(`type Unused = { a: number };\n\n\nthrow new Error("boom");\n`);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /entry\.ts:4:\d+/);
});

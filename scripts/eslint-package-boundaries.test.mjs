import { after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { focalePlugin, WORKSPACE_PACKAGES, WORKSPACE_ROOT } from "./eslint-package-boundaries.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = after;

const at = relative => path.join(WORKSPACE_ROOT, relative);
// The specifier is the code's first quoted string.
const forbidden = (filename, code, from, to) => ({
  filename: at(filename),
  code,
  errors: [{ messageId: "forbidden", data: { from, to, specifier: /["'`]([^"'`]+)["'`]/.exec(code)[1] } }],
});

new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
}).run("focale/package-boundaries", focalePlugin.rules["package-boundaries"], {
  valid: [
    { filename: at("packages/contracts/src/x.ts"), code: `import { z } from "zod";` },
    { filename: at("packages/shared/src/x.ts"), code: `import { AppConfig } from "@app/contracts";` },
    { filename: at("packages/db/src/x.ts"), code: `import { a } from "@app/shared"; import type { B } from "@app/contracts";` },
    { filename: at("packages/db/tests/db/x.db.test.ts"), code: `import { getDb } from "@app/db"; import { f } from "../helpers/factories";` },
    { filename: at("packages/integrations/src/x.ts"), code: `export * from "@app/db"; export { a } from "./a";` },
    {
      filename: at("apps/api/src/modules/n/x.ts"),
      code: `import { q } from "@app/integrations"; const db = await import("@app/db"); type S = typeof import("@app/shared");`,
    },
    // Direction is allowed, even through a relative path into a lower package.
    { filename: at("apps/api/src/modules/n/x.db.test.ts"), code: `import { f } from "../../../../../packages/db/tests/helpers/factories";` },
    { filename: at("apps/worker/src/jobs/x.ts"), code: `import { run } from "../job-runner"; const m = await import(specifier);` },
    // Outside the workspace packages (legacy src/, root files): not policed.
    { filename: at("src/legacy.ts"), code: `import { AppModule } from "@app/api";` },
  ],
  invalid: [
    forbidden("packages/contracts/src/x.ts", `import { a } from "@app/shared";`, "packages/contracts", "@app/shared"),
    forbidden("packages/shared/src/x.ts", `import { getDb } from "@app/db";`, "packages/shared", "@app/db"),
    forbidden("packages/shared/src/x.ts", `const db = require("@app/db");`, "packages/shared", "@app/db"),
    forbidden("packages/db/src/x.ts", `import { send } from "@app/integrations/email";`, "packages/db", "@app/integrations"),
    // Relative path that leaves packages/db without naming "packages/".
    forbidden("packages/db/src/queries/x.ts", `import { q } from "../../../integrations/src/email/queue";`, "packages/db", "@app/integrations"),
    forbidden("packages/db/tests/db/x.db.test.ts", `import { renderEmail } from "@app/integrations";`, "packages/db", "@app/integrations"),
    forbidden("packages/integrations/src/x.ts", `export { AppModule } from "@app/api";`, "packages/integrations", "@app/api"),
    forbidden("packages/integrations/src/x.ts", `export * from "@app/worker";`, "packages/integrations", "@app/worker"),
    forbidden("apps/api/src/x.ts", `import { JobRunner } from "@app/worker";`, "apps/api", "@app/worker"),
    forbidden("apps/api/src/x.ts", "const w = await import(`@app/worker`);", "apps/api", "@app/worker"),
    forbidden("apps/api/src/x.ts", `import w = require("@app/worker");`, "apps/api", "@app/worker"),
    forbidden("apps/worker/src/x.ts", `const m = await import("../../api/src/app.module");`, "apps/worker", "@app/api"),
    forbidden("apps/worker/src/x.ts", `type M = typeof import("@app/api");`, "apps/worker", "@app/api"),
  ],
});

test("the layer table covers every workspace package under its @app/ name", () => {
  const onDisk = ["apps", "packages"].flatMap(group =>
    readdirSync(at(group))
      .filter(name => existsSync(at(`${group}/${name}/package.json`)))
      .map(name => {
        const { name: packageName } = JSON.parse(readFileSync(at(`${group}/${name}/package.json`), "utf8"));
        return [packageName, `${group}/${name}`];
      }),
  );
  const table = Object.entries(WORKSPACE_PACKAGES).map(([key, { dir }]) => [`@app/${key}`, dir]);
  assert.deepEqual(new Map(onDisk), new Map(table));
});

test("the workspace config holds the 6.7 rules at error level", async () => {
  const eslint = new ESLint({ cwd: WORKSPACE_ROOT });
  const severity = setting => (Array.isArray(setting) ? setting[0] : setting);
  for (const file of ["apps/api/src/main.ts", "packages/db/src/index.ts"]) {
    const { rules } = await eslint.calculateConfigForFile(at(file));
    for (const rule of [
      "@typescript-eslint/no-floating-promises",
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/no-unused-vars",
      "focale/package-boundaries",
    ]) {
      assert.equal(severity(rules[rule]), 2, `${rule} in ${file}`);
    }
  }
  const { rules } = await eslint.calculateConfigForFile(at("packages/db/tests/db/x.db.test.ts"));
  assert.equal(severity(rules["focale/package-boundaries"]), 2);
  assert.equal(severity(rules["@typescript-eslint/no-unused-vars"]), 2);
});

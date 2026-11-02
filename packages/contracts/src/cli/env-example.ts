// Writes .env.example (in the current directory) from the zod schema metadata.
//   pnpm env:example           regenerate
//   pnpm env:example --check   exit 1 when the committed file is stale (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderEnvExample } from "../env-example";

const target = resolve(process.cwd(), ".env.example");
const expected = renderEnvExample();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf-8");
  } catch {
    // Missing file: reported as stale below.
  }
  if (current !== expected) {
    console.error(".env.example is out of date with packages/contracts/src/app-config.ts. Run `pnpm env:example` and commit the result.");
    process.exitCode = 1;
  } else {
    console.log(".env.example is up to date.");
  }
} else {
  writeFileSync(target, expected);
  console.log(`Wrote ${target}`);
}

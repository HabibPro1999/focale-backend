// Writes packages/contracts/generated/ (JSON Schema, TypeScript types and
// condition parity fixtures for the admin and form repos).
//   pnpm contracts:generate           regenerate (removes files it no longer produces)
//   pnpm contracts:generate --check   exit 1 when the committed files are stale (CI)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { renderContractArtifacts } from "../artifacts/render";

// Same depth from src/cli and dist/cli.
const contractsDir = resolve(__dirname, "..", "..");
const generatedDir = join(contractsDir, "generated");
const sharedSrcDir = resolve(contractsDir, "..", "shared", "src");

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .sort();
  } catch {
    return []; // No folder yet.
  }
}

const expected = renderContractArtifacts(sharedSrcDir);
const expectedPaths = new Set(expected.map((file) => file.path));
const extra = listFiles(generatedDir).filter((path) => !expectedPaths.has(path));

if (process.argv.includes("--check")) {
  const stale: string[] = [];
  for (const file of expected) {
    let current: string | undefined;
    try {
      current = readFileSync(join(generatedDir, file.path), "utf8");
    } catch {
      // Missing: reported below.
    }
    if (current === undefined) stale.push(`missing: ${file.path}`);
    else if (current !== file.content) stale.push(`out of date: ${file.path}`);
  }
  stale.push(...extra.map((path) => `not generated: ${path}`));
  if (stale.length > 0) {
    console.error(
      `packages/contracts/generated is stale:\n  ${stale.join("\n  ")}\n` +
        "Run `pnpm contracts:generate` and commit the result.",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`packages/contracts/generated is up to date (${expected.length} files).\n`);
  }
} else {
  for (const path of extra) rmSync(join(generatedDir, path));
  for (const file of expected) {
    const target = join(generatedDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  process.stdout.write(
    `Wrote ${expected.length} files to ${generatedDir}${extra.length ? ` (removed ${extra.length})` : ""}.\n`,
  );
}

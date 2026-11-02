import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLAGS = ["static", "image", "migration", "database", "concurrency"];
const WORKSPACE = /^(?:apps\/(?:api|worker)|packages\/(?:contracts|shared|db|integrations))\//;

/** Unknown paths select everything; only known, bounded categories skip work. */
export function planForPaths(paths, forceFull = false) {
  const plan = Object.fromEntries(FLAGS.map(name => [name, forceFull]));
  const enable = (...names) => names.forEach(name => { plan[name] = true; });
  for (const path of paths) {
    if (/^[^/]+\.md$/.test(path) || /^docs\/.*\.(?:md|png|jpg|jpeg|svg|webp)$/.test(path)) continue;
    if (WORKSPACE.test(path) && /\.migration\.test\.[cm]?[jt]s$/.test(path)) {
      enable("static", "migration");
    } else if (WORKSPACE.test(path) && /\.db\.test\.[cm]?[jt]s$/.test(path)) {
      enable("static", "database");
    } else if (WORKSPACE.test(path) && /\.concurrency\.test\.[cm]?[jt]s$/.test(path)) {
      enable("static", "concurrency");
    } else if (WORKSPACE.test(path) && /\.test\.[cm]?[jt]s$/.test(path)) {
      enable("static");
    } else if (path === "eslint.config.mjs" || /^scripts\/eslint-[^/]+\.mjs$/.test(path)) {
      enable("static");
    } else if (
      /^(?:apps\/(?:api|worker)|packages\/integrations)\/src\//.test(path) ||
      /^packages\/db\/src\/(?:queries|settlement|policy|outbox|lease-queue|ops)\//.test(path)
    ) {
      enable("static", "database", "concurrency");
    } else {
      // Includes CI, runtime launchers, manifests/lockfiles, migrations/schema,
      // DB connection/test infrastructure, shared contracts/helpers and new packages.
      enable(...FLAGS);
    }
  }
  const include = [];
  for (const engine of ["postgres", "cockroach"]) {
    for (const [tier, command, shards] of [
      ["migration", "test:migration", 1],
      ["database", "test:db", engine === "cockroach" ? 4 : 1],
      ["concurrency", "test:concurrency", engine === "cockroach" ? 2 : 1],
    ]) {
      if (!plan[tier]) continue;
      for (let index = 1; index <= shards; index++) {
        include.push({ engine, command, shard: shards === 1 ? "" : `${index}/${shards}` });
      }
    }
  }
  return { ...plan, db: include.length > 0, matrix: { include } };
}

/** NUL-delimited, rename-disabled diff includes both deleted and added paths. */
export function changedPaths(eventName, event, cwd = process.cwd()) {
  const isPr = eventName === "pull_request";
  if (!isPr && eventName !== "push") throw new Error("Full validation requested");
  const base = isPr ? event.pull_request?.base?.sha : event.before;
  const head = isPr ? event.pull_request?.head?.sha : event.after;
  for (const sha of [base, head]) {
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) {
      throw new Error("Missing usable comparison commit");
    }
  }
  const range = `${base}${isPr ? "..." : ".."}${head}`;
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range, "--"], {
    cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
}

/** A selected job must succeed; failure, cancellation and unexpected skips fail the gate. */
export function requiredCheckErrors(required, results) {
  if (results.plan !== "success") return ["CI planning did not succeed"];
  const errors = [];
  for (const name of ["static", "db", "image"]) {
    if (typeof required[name] !== "boolean") errors.push(`Invalid ${name} selection`);
    else if (required[name] && results[name] !== "success") errors.push(`${name}: ${results[name]}`);
    else if (!required[name] && !["skipped", "success"].includes(results[name])) errors.push(`${name}: ${results[name]}`);
  }
  return errors;
}

function main() {
  if (process.argv[2] === "check") {
    const required = {};
    const results = { plan: process.env.CI_PLAN_RESULT };
    for (const name of ["static", "db", "image"]) {
      const value = process.env[`CI_${name.toUpperCase()}_REQUIRED`];
      required[name] = value === "true" ? true : value === "false" ? false : undefined;
      results[name] = process.env[`CI_${name.toUpperCase()}_RESULT`];
    }
    const errors = requiredCheckErrors(required, results);
    if (errors.length) throw new Error(errors.join("; "));
    console.log("Every selected CI check passed.");
    return;
  }
  let paths = [];
  let reason = "changed paths";
  let forceFull = false;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    paths = changedPaths(process.env.GITHUB_EVENT_NAME, event);
  } catch {
    // Manual run, initial/force push with unavailable history, or a failed diff:
    // run everything instead of silently treating the change as documentation.
    forceFull = true;
    reason = "manual run or unavailable comparison; full validation";
  }
  const plan = planForPaths(paths, forceFull);
  const outputs = { static: plan.static, image: plan.image, db: plan.db, matrix: JSON.stringify(plan.matrix) };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## CI selection\n\n${paths.length} changed paths; ${reason}.\n\n` +
      FLAGS.map(name => `- ${name}: ${plan[name] ? "run" : "skip"}\n`).join(""));
  }
  console.log(JSON.stringify({ reason, changedPaths: paths.length, ...plan }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

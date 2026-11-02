import { APP_ENV_SHAPE } from "./app-config";
import { ENV_SECTIONS, envKeyMeta, type EnvSection } from "./env-meta";

const HEADER = [
  "# Focale backend environment template. GENERATED from the zod schema in",
  "# packages/contracts/src/app-config.ts (.meta() on each key): do not edit by hand.",
  "# Regenerate with `pnpm env:example`; CI fails on drift (`pnpm env:example --check`).",
  "#",
  "# Copy to .env for local development and replace placeholders before running the app.",
  "# Never commit real .env files or production secrets. Blank values mean unset.",
  "# Check a deployed environment against the production rules (prints failing key names",
  "# only, never values): node packages/contracts/dist/cli/check-config.js",
];

/** Render `.env.example` from the schema metadata. */
export function renderEnvExample(): string {
  const bySection = new Map<EnvSection, string[]>();
  for (const [key, schema] of Object.entries(APP_ENV_SHAPE)) {
    const meta = envKeyMeta(schema);
    if (!meta) throw new Error(`Environment key ${key} has no .meta() documentation`);
    const lines = bySection.get(meta.section) ?? [];
    for (const line of meta.description ? meta.description.split("\n") : []) {
      lines.push(line ? `# ${line}` : "#");
    }
    lines.push(`${meta.active ? "" : "# "}${key}=${meta.example ?? ""}`);
    bySection.set(meta.section, lines);
  }

  const out = [...HEADER];
  for (const [section, title] of Object.entries(ENV_SECTIONS) as [EnvSection, string][]) {
    const lines = bySection.get(section);
    if (!lines) continue;
    out.push("", `# --- ${title} ---`, ...lines);
  }
  return `${out.join("\n")}\n`;
}

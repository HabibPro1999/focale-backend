import { z } from "zod";

/** `.env.example` sections, in file order. */
export const ENV_SECTIONS = {
  core: "Core",
  database: "Database",
  http: "HTTP",
  urls: "Public URLs",
  firebase: "Firebase",
  storage: "Storage",
  email: "Email",
  realtime: "Realtime (Server-Sent Events)",
  abstracts: "Abstracts",
  certificates: "Certificates",
  networking: "B2B networking",
  processes: "Processes",
} as const;

export type EnvSection = keyof typeof ENV_SECTIONS;

/**
 * Documentation carried on every environment key through zod `.meta()`; the
 * `.env.example` generator (env-example.ts) renders it.
 */
export type EnvKeyMeta = {
  section: EnvSection;
  /** Comment lines above the key (split on "\n"). */
  description: string;
  /** Value shown in `.env.example`; placeholders only, never real secrets. */
  example?: string;
  /** Uncommented in `.env.example` (a working local-development value). */
  active?: boolean;
};

/** An unset Render/.env variable often arrives as "" — treat blank as unset. */
function blankAsUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/** One environment key: blank means unset, documented through `.meta()`. */
export function envKey<T extends z.ZodType>(schema: T, meta: EnvKeyMeta) {
  return z.preprocess(blankAsUndefined, schema).meta(meta);
}

/** "true"/"false" flag with a default. */
export function envFlag(defaultValue: boolean, meta: EnvKeyMeta) {
  return envKey(
    z
      .enum(["true", "false"])
      .default(defaultValue ? "true" : "false")
      .transform((value) => value === "true"),
    meta,
  );
}

/** A decimal integer (digits only, so "1e3" or "30s" fail) within bounds. */
export function envInt(min: number, max: number, defaultValue: number, meta: EnvKeyMeta, name: string) {
  const message = `${name} must be an integer from ${min} to ${max}`;
  return envKey(
    z.preprocess(
      (value) =>
        typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : value,
      z
        .number({ error: message })
        .int({ error: message })
        .min(min, { error: message })
        .max(max, { error: message })
        .default(defaultValue),
    ),
    meta,
  );
}

export function envKeyMeta(schema: z.ZodType): EnvKeyMeta | undefined {
  return schema.meta() as EnvKeyMeta | undefined;
}

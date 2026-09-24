import { parseAppConfig, type AppConfig } from "@app/contracts";

export type Config = AppConfig;

let pinned: Config | undefined;

/**
 * Boot: parse process.env once (throws ConfigError, fail fast) and pin the
 * result as this process's config. main.ts calls it first and hands the
 * config to buildApp / configureDb / configureIntegrations.
 */
export function loadConfig(): Config {
  pinned ??= parseAppConfig(process.env);
  return pinned;
}

/**
 * The pinned boot config. Code running without a boot (unit tests, one-off
 * scripts) gets a fresh parse of process.env on each call instead.
 */
export function getConfig(): Config {
  return pinned ?? parseAppConfig(process.env);
}

export const CONFIG = Symbol("CONFIG");

import { parseAppConfig, type AppConfig } from "@app/contracts";

export type Config = AppConfig;

let pinned: Config | undefined;

/**
 * Boot: parse process.env once (throws ConfigError, fail fast) and pin the
 * result. main.ts hands the slices to configureDb / configureIntegrations.
 */
export function loadConfig(): Config {
  pinned ??= parseAppConfig(process.env);
  return pinned;
}

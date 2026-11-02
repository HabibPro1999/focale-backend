import { parseAppConfig, type AppConfig } from "@app/contracts";

export type Config = AppConfig;

let pinned: Config | undefined;

/**
 * Boot: parse process.env once (throws ConfigError, fail fast) and pin the
 * result. main.ts hands it to configureRuntime, which gives each package its
 * slice.
 */
export function loadConfig(): Config {
  pinned ??= parseAppConfig(process.env);
  return pinned;
}

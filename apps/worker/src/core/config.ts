import { parseAppConfig, type AppConfig } from "@app/contracts";

export type Config = AppConfig;

/** Parse + validate env once at boot. Throws ConfigError (fail fast) on invalid config. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return parseAppConfig(source);
}

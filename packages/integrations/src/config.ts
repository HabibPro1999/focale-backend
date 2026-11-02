import {
  integrationsConfigFromEnv,
  type IntegrationsConfig,
  type NetworkingRuntimeConfig,
} from "@app/contracts";

export type { IntegrationsConfig, NetworkingRuntimeConfig };

let configured: IntegrationsConfig | undefined;

/**
 * Hand this package its typed config slice, parsed once at boot by the app
 * (parseAppConfig(...).integrations). Call before any integration is used.
 */
export function configureIntegrations(config: IntegrationsConfig): void {
  configured = config;
}

/** Forget the configured slice (tests). */
export function resetIntegrationsConfig(): void {
  configured = undefined;
}

/**
 * The configured slice. Code paths that never call configureIntegrations
 * (unit tests, one-off scripts) read the same keys from the environment on
 * each call, without the app's production rules.
 */
export function integrationsConfig(): IntegrationsConfig {
  return configured ?? integrationsConfigFromEnv(process.env);
}

export function networkingConfig(): NetworkingRuntimeConfig {
  return integrationsConfig().networking;
}

import { validateAppEnv, type ConfigIssue } from "./app-config";

export interface ProductionConfigReport {
  ok: boolean;
  /** One entry per failing key; rule text only, never the configured value. */
  issues: ConfigIssue[];
  /** The environment's own NODE_ENV was not "production". */
  nodeEnvOverridden: boolean;
}

/**
 * Validate an environment with the production rules (NODE_ENV forced to
 * production). Pure: reads nothing but `source` and connects to nothing.
 */
export function checkProductionConfig(source: NodeJS.ProcessEnv): ProductionConfigReport {
  const result = validateAppEnv({ ...source, NODE_ENV: "production" });
  return {
    ok: result.ok,
    issues: result.ok ? [] : result.issues,
    nodeEnvOverridden: source.NODE_ENV !== "production",
  };
}

/** Human-readable report: key names and rule text, never values. */
export function formatProductionConfigReport(report: ProductionConfigReport): string {
  const lines: string[] = [];
  if (report.nodeEnvOverridden) {
    lines.push("Note: NODE_ENV here is not production; checked with the production rules anyway.");
  }
  if (report.ok) {
    lines.push("Production config check passed: every key satisfies the production rules.");
    return lines.join("\n");
  }
  const keys = [...new Set(report.issues.map((issue) => issue.key))];
  lines.push(`Production config check failed: ${keys.length} key(s) need attention.`);
  for (const issue of report.issues) lines.push(`  - ${issue.key}: ${issue.message}`);
  return lines.join("\n");
}

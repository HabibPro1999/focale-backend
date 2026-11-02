import { redactCredentials } from "./security";
import type { MigrationAdoptionReport } from "./types";

/** Human-readable adoption report; every line is credential-redacted. */
export function formatAdoptionReport(report: MigrationAdoptionReport, writeLedger: boolean): string[] {
  const lines: string[] = [];
  const mode = writeLedger ? "apply" : "dry run (no changes)";
  lines.push(`Migration adoption (${report.engine}; ${mode}):`);
  for (const assessment of report.assessments) {
    const verdict = assessment.abort ? "ABORT" : assessment.classification ?? "?";
    const catalog = assessment.evidence.catalog as { state: string; matched: number; total: number; failed?: string[] } | undefined;
    const parts: string[] = [];
    if (catalog) parts.push(`probes ${catalog.matched}/${catalog.total} (${catalog.state})`);
    const legacy = assessment.evidence.legacyNetworking as { name: string; recorded?: unknown; invalid?: string } | undefined;
    if (legacy) {
      parts.push(
        legacy.invalid
          ? `networking_migrations invalid`
          : `networking_migrations ${legacy.recorded === true ? "recorded" : legacy.recorded === "steps-only" ? "steps only" : "no record"}`,
      );
    }
    const prisma = assessment.evidence.prisma as { finished: number; latest: string | null } | undefined;
    if (prisma) parts.push(`_prisma_migrations ${prisma.finished} finished${prisma.latest ? ` (latest ${prisma.latest})` : ""}`);
    if (assessment.carriedSteps.length) parts.push(`legacy steps ${assessment.carriedSteps.join(",")} carried`);
    lines.push(`  ${assessment.migration.id} ${verdict.padEnd(8)} [${assessment.migration.variant}] ${parts.join("; ")}`);
    if (catalog?.failed?.length && (assessment.abort || catalog.state === "partial")) {
      for (const failed of catalog.failed) lines.push(`         missing: ${failed}`);
    }
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const error of report.errors) lines.push(`error: ${error}`);
  if (report.aborted) lines.push("Adoption aborted; nothing was written.");
  else if (writeLedger) lines.push(`Wrote ${report.written.migrations} migration record(s) and ${report.written.steps} step record(s).`);
  else lines.push("Dry run only; re-run with --apply to write these ledger rows.");
  return lines.map(redactCredentials);
}

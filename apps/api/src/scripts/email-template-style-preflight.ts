import {
  emailTemplates,
  getDb,
  updateEmailTemplate,
} from "@app/db";
import { runEmailTemplateStylePreflight } from "../modules/email/email-template-style-preflight";

// Run from apps/api with `node --conditions=@app/source -r @swc-node/register src/scripts/email-template-style-preflight.ts`.
// Review the default dry-run output before rerunning with `--apply`.
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }

  const db = getDb();

  try {
    const rows = await db
      .select({
        id: emailTemplates.id,
        name: emailTemplates.name,
        content: emailTemplates.content,
        updatedAt: emailTemplates.updatedAt,
      })
      .from(emailTemplates);

    const summary = await runEmailTemplateStylePreflight(rows, {
      apply,
      update: (row, update) =>
        updateEmailTemplate(
          row.id,
          {
            content: update.content,
            mjmlContent: update.mjmlContent,
            htmlContent: update.htmlContent,
            plainContent: update.plainContent,
          },
          row.updatedAt,
        ),
    });

    console.log(
      `Scanned ${summary.scanned} email template(s); mode=${apply ? "apply" : "dry-run"}.`,
    );
    for (const report of summary.reports) {
      const label = `${report.id} (${report.name})`;
      if (report.changes.length > 0) {
        const changeSummary = report.changes
          .map(({ path, attribute, action }) => `${path}.${attribute}:${action}`)
          .join(", ");
        console.log(`[STYLE ATTRS] ${label}: ${changeSummary}`);
      }
      if (report.suspiciousAttributes.length > 0) {
        console.log(
          `[SUSPICIOUS ATTRS] ${label}: ${report.suspiciousAttributes.join(", ")}`,
        );
      }
      if (report.status === "manual-review") {
        console.error(
          `[MANUAL REVIEW] ${label}: ${report.validationIssues.join("; ") || report.detail || "preflight failed"}`,
        );
      } else if (report.status === "conflict") {
        console.error(`[CONCURRENT EDIT] ${label}: ${report.detail}.`);
      }
    }

    console.log(
      `${apply ? "Updated" : "Would update"} ${apply ? summary.updated : summary.wouldUpdate} template(s); ${summary.manualReview} need manual review; ${summary.conflicts} concurrent edit(s) skipped.`,
    );
    if (summary.manualReview > 0 || summary.conflicts > 0) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

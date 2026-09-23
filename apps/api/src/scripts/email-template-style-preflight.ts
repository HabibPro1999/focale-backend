import {
  emailTemplates,
  getDb,
  updateEmailTemplate,
} from "@app/db";
import {
  compileMjmlToHtml,
  extractPlainText,
  renderTemplateToMjml,
} from "@app/integrations";
import { preflightEmailTemplateContent } from "../modules/email/email-template-style-preflight";

// Run from apps/api with `node --conditions=@app/source -r @swc-node/register src/scripts/email-template-style-preflight.ts`.
// Review the default dry-run output before rerunning with `--apply`.
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }

  const db = getDb();
  let changed = 0;
  let manualReview = 0;
  let conflicts = 0;

  try {
    const rows = await db
      .select({
        id: emailTemplates.id,
        name: emailTemplates.name,
        content: emailTemplates.content,
        updatedAt: emailTemplates.updatedAt,
      })
      .from(emailTemplates);

    console.log(
      `Scanned ${rows.length} email template(s); mode=${apply ? "apply" : "dry-run"}.`,
    );

    for (const row of rows) {
      const preflight = preflightEmailTemplateContent(row.content);
      if (preflight.changes.length === 0) {
        if (preflight.validationIssues.length > 0) {
          manualReview += 1;
          console.error(
            `[MANUAL REVIEW] ${row.id} (${row.name}): ${preflight.validationIssues.join("; ")}`,
          );
        }
        continue;
      }

      const changeSummary = preflight.changes
        .map(({ path, attribute, action }) => `${path}.${attribute}:${action}`)
        .join(", ");
      console.log(`[STYLE ATTRS] ${row.id} (${row.name}): ${changeSummary}`);

      if (!preflight.content) {
        manualReview += 1;
        console.error(
          `[MANUAL REVIEW] ${row.id} (${row.name}): ${preflight.validationIssues.join("; ")}`,
        );
        continue;
      }

      try {
        const mjmlContent = renderTemplateToMjml(preflight.content);
        const { html: htmlContent } = compileMjmlToHtml(mjmlContent);
        const plainContent = extractPlainText(preflight.content);
        changed += 1;

        if (!apply) continue;

        const updated = await updateEmailTemplate(
          row.id,
          {
            content: preflight.content,
            mjmlContent,
            htmlContent,
            plainContent,
          },
          row.updatedAt,
        );
        if (!updated) {
          conflicts += 1;
          console.error(
            `[CONCURRENT EDIT] ${row.id} (${row.name}) changed after the scan; skipped.`,
          );
        }
      } catch (error) {
        manualReview += 1;
        console.error(
          `[MANUAL REVIEW] ${row.id} (${row.name}): could not re-render (${error instanceof Error ? error.message : "unknown error"}).`,
        );
      }
    }

    console.log(
      `${apply ? "Updated" : "Would update"} ${changed - conflicts} template(s); ${manualReview} need manual review; ${conflicts} concurrent edit(s) skipped.`,
    );
    if (manualReview > 0 || conflicts > 0) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

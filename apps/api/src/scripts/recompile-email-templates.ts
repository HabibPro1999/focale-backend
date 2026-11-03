import {
  emailTemplates,
  getDb,
  updateEmailTemplateRenderings,
} from "@app/db";
import type { TiptapDocument } from "@app/contracts";
import {
  compileTemplateContent,
  getTemplateLanguage,
} from "../modules/email/template-content";

// Recompiles every stored email template (mjml/html/plain) from its Tiptap
// content with the current renderer and the template's language: the layout
// and the link labels are baked in when a template is saved, so templates
// saved before a renderer change keep the old output until recompiled.
//
// Run from apps/api with
// `node --conditions=@app/source -r @swc-node/register src/scripts/recompile-email-templates.ts --dry-run`,
// then again without `--dry-run`. DATABASE_URL comes from the environment.
// `updatedAt` is kept, so an admin editing a template meanwhile gets no
// spurious conflict; a template edited during the run is skipped.

/** An error in one line: a failed query's database cause, not its SQL and params. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message.split("\n")[0];
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }

  const db = getDb();

  try {
    const rows = await db
      .select({
        id: emailTemplates.id,
        eventId: emailTemplates.eventId,
        abstractTrigger: emailTemplates.abstractTrigger,
        content: emailTemplates.content,
        updatedAt: emailTemplates.updatedAt,
      })
      .from(emailTemplates);

    const byLanguage: Record<string, number> = {};
    const updated: string[] = [];
    const conflicts: string[] = [];
    const failed: string[] = [];

    for (const row of rows) {
      try {
        const language = await getTemplateLanguage(row);
        const compiled = await compileTemplateContent(
          row.content as TiptapDocument,
          language,
        );
        byLanguage[language] = (byLanguage[language] ?? 0) + 1;
        if (dryRun) {
          updated.push(`${row.id} (${language})`);
          continue;
        }
        const written = await updateEmailTemplateRenderings(
          row.id,
          compiled,
          row.updatedAt,
        );
        if (written) updated.push(`${row.id} (${language})`);
        else conflicts.push(row.id);
      } catch (error) {
        failed.push(`${row.id}: ${describeError(error)}`);
      }
    }

    log(
      `Scanned ${rows.length} email template(s); mode=${dryRun ? "dry-run" : "apply"}.`,
    );
    log(
      `By language: ${Object.entries(byLanguage)
        .map(([language, n]) => `${language}=${n}`)
        .join(", ") || "none"}.`,
    );
    for (const id of updated) {
      log(`${dryRun ? "[WOULD RECOMPILE]" : "[RECOMPILED]"} ${id}`);
    }
    for (const id of conflicts) {
      console.error(`[CONCURRENT EDIT] ${id}: template changed during the run, skipped.`);
    }
    for (const line of failed) console.error(`[FAILED] ${line}`);

    log(
      `${dryRun ? "Would recompile" : "Recompiled"} ${updated.length} template(s); ${conflicts.length} concurrent edit(s) skipped; ${failed.length} failed.`,
    );
    if (conflicts.length > 0 || failed.length > 0) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

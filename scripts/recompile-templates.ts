/// <reference types="node" />
/**
 * One-time script to recompile all email templates.
 * Re-runs Tiptap JSON → MJML → HTML pipeline so stored HTML
 * picks up any changes to labels, rendering logic, etc.
 *
 * Usage:
 *   DRY RUN (default):  bunx dotenv -e .env.prod -- npx tsx scripts/recompile-templates.ts
 *   APPLY:              bunx dotenv -e .env.prod -- npx tsx scripts/recompile-templates.ts --apply
 *
 * Dry run shows a before/after diff of button labels without touching the DB.
 * --apply wraps all updates in a single transaction (all-or-nothing).
 */
import "dotenv/config";
import { prisma } from "../src/database/client.js";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
} from "../src/modules/email/email-renderer.service.js";
import type { TiptapDocument } from "../src/modules/email/email.types.js";

const apply = process.argv.includes("--apply");

/** Extract mj-button labels from MJML for diffing */
function extractButtonLabels(mjml: string): string[] {
  const matches = mjml.match(/<mj-button[^>]*>([^<]+)<\/mj-button>/g) || [];
  return matches.map((m) => m.replace(/<\/?mj-button[^>]*>/g, ""));
}

async function main() {
  console.log(
    apply ? "MODE: APPLY (will update DB)\n" : "MODE: DRY RUN (no changes)\n",
  );

  const templates = await prisma.emailTemplate.findMany({
    where: { content: { not: undefined } },
    select: { id: true, name: true, content: true, mjmlContent: true },
  });

  console.log(`Found ${templates.length} template(s).\n`);

  type Pending = {
    id: string;
    name: string;
    mjmlContent: string;
    htmlContent: string;
    plainContent: string;
  };

  const pending: Pending[] = [];
  let errors = 0;

  for (const template of templates) {
    if (!template.content) continue;

    try {
      const content = template.content as unknown as TiptapDocument;
      const mjmlContent = renderTemplateToMjml(content);
      const { html: htmlContent } = compileMjmlToHtml(mjmlContent);
      const plainContent = extractPlainText(content);

      // Show diff
      const oldLabels = extractButtonLabels(template.mjmlContent || "");
      const newLabels = extractButtonLabels(mjmlContent);
      const changed = JSON.stringify(oldLabels) !== JSON.stringify(newLabels);

      console.log(`${changed ? "~" : "="} ${template.name} (${template.id})`);
      if (changed) {
        console.log(`    old buttons: ${oldLabels.join(", ") || "(none)"}`);
        console.log(`    new buttons: ${newLabels.join(", ") || "(none)"}`);
      }

      pending.push({
        id: template.id,
        name: template.name,
        mjmlContent,
        htmlContent,
        plainContent,
      });
    } catch (err) {
      errors++;
      console.error(
        `  ✗ ${template.name} (${template.id}): ${(err as Error).message}`,
      );
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} template(s) failed to compile. Aborting.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!apply) {
    console.log(
      `\nDry run complete. ${pending.length} template(s) would be updated.`,
    );
    console.log("Re-run with --apply to write changes.");
    await prisma.$disconnect();
    return;
  }

  // All-or-nothing transaction
  await prisma.$transaction(
    pending.map((t) =>
      prisma.emailTemplate.update({
        where: { id: t.id },
        data: {
          mjmlContent: t.mjmlContent,
          htmlContent: t.htmlContent,
          plainContent: t.plainContent,
        },
      }),
    ),
  );

  console.log(
    `\nDone. Recompiled ${pending.length} template(s) in a single transaction.`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("Failed:", error.message);
  await prisma.$disconnect();
  process.exit(1);
});

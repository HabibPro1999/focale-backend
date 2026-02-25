/// <reference types="node" />
/**
 * Check what link labels are stored in prod email templates.
 * Run: bunx dotenv-cli -e .env.prod -- npx tsx scripts/check-template-labels.ts
 */
import "dotenv/config";
import { prisma } from "../src/database/client.js";

async function main() {
  const templates = await prisma.emailTemplate.findMany({
    select: { id: true, name: true, htmlContent: true, mjmlContent: true },
  });

  for (const t of templates) {
    const html = t.htmlContent || "";
    const mjml = t.mjmlContent || "";

    // Extract <a> link texts
    const anchors = html.match(/<a [^>]*?>([^<]+)<\/a>/g) || [];
    const anchorTexts = anchors.map((a) => a.replace(/<[^>]*>/g, "").trim());

    // Extract mj-button texts
    const buttons = mjml.match(/<mj-button[^>]*>([^<]+)<\/mj-button>/g) || [];
    const buttonTexts = buttons.map((b) => b.replace(/<[^>]*>/g, "").trim());

    console.log(`\n${t.name} (${t.id})`);
    if (anchorTexts.length) console.log("  <a> links:", anchorTexts);
    if (buttonTexts.length) console.log("  <mj-button>:", buttonTexts);
    if (!anchorTexts.length && !buttonTexts.length)
      console.log("  (no link/button labels found)");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});

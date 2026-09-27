import type { TiptapDocument } from "@app/contracts";
import {
  compileMjmlToHtml,
  extractPlainText,
  renderTemplateToMjml,
} from "@app/integrations";

/** The stored renderings of a template's Tiptap content. */
export interface CompiledTemplateContent {
  mjmlContent: string;
  htmlContent: string;
  plainContent: string;
}

/** Tiptap content → MJML → HTML, plus its plain text. */
export async function compileTemplateContent(
  content: TiptapDocument,
): Promise<CompiledTemplateContent> {
  const mjmlContent = renderTemplateToMjml(content);
  const { html: htmlContent } = await compileMjmlToHtml(mjmlContent);
  return { mjmlContent, htmlContent, plainContent: extractPlainText(content) };
}

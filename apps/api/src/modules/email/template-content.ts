import {
  DEFAULT_LANGUAGE,
  type AbstractEmailTrigger,
  type LanguageCode,
  type TiptapDocument,
} from "@app/contracts";
import { getAbstractConfigLanguage, getRegistrationFormLanguage } from "@app/db";
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

/**
 * Tiptap content → MJML → HTML, plus its plain text. `language` is the
 * template's (getTemplateLanguage): link labels and the layout's footer and
 * direction are baked in here.
 */
export async function compileTemplateContent(
  content: TiptapDocument,
  language: LanguageCode,
): Promise<CompiledTemplateContent> {
  const mjmlContent = renderTemplateToMjml(content, { language });
  const { html: htmlContent } = await compileMjmlToHtml(mjmlContent);
  return { mjmlContent, htmlContent, plainContent: extractPlainText(content) };
}

/**
 * A template's language: its event's abstract config language for an
 * abstract-trigger template, else its event's registration-form language; fr
 * without an event.
 */
export async function getTemplateLanguage(template: {
  eventId: string | null;
  abstractTrigger: AbstractEmailTrigger | null;
}): Promise<LanguageCode> {
  if (!template.eventId) return DEFAULT_LANGUAGE;
  return template.abstractTrigger
    ? getAbstractConfigLanguage(template.eventId)
    : getRegistrationFormLanguage(template.eventId);
}

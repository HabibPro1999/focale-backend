import type { AbstractConfigRow } from "@app/db";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";
import {
  abstractContentFields,
  abstractHtmlToText,
  sanitizeAbstractContent,
  STRUCTURED_SECTIONS,
  type AbstractContent,
} from "./abstracts.html";

export function countWords(s: string): number {
  if (!s) return 0;
  return s
    .replace(/[\u00A0\u2000-\u200B\u3000]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function validateMode(contentMode: string, configMode: string): void {
  if (contentMode !== configMode) {
    throw new AppException(
      ErrorCodes.ABSTRACT_MODE_MISMATCH,
      `Submission mode mismatch: expected ${configMode}, got ${contentMode}`,
      409,
    );
  }
}

function validateContentPresence(content: AbstractContent): void {
  const emptyFields = abstractContentFields(content)
    .filter((field) => abstractHtmlToText(field.value).length === 0)
    .map((field) => field.name);
  if (emptyFields.length === 0) return;
  throw new AppException(
    ErrorCodes.VALIDATION_ERROR,
    `Required abstract content is empty: ${emptyFields.join(", ")}`,
    422,
    { fields: emptyFields },
  );
}

function validateWordLimits(
  content: AbstractContent,
  config: AbstractConfigRow,
): void {
  const errors: string[] = [];

  if (content.mode === "FREE_TEXT") {
    const bodyText = abstractHtmlToText(content.body);
    if (
      config.globalWordLimit != null &&
      countWords(bodyText) > config.globalWordLimit
    ) {
      errors.push(
        `body (${countWords(bodyText)} words, limit ${config.globalWordLimit})`,
      );
    }
  } else {
    const sectionLimits =
      (config.sectionWordLimits as Record<string, number> | null) ?? {};
    let total = 0;
    for (const section of STRUCTURED_SECTIONS) {
      const wordCount = countWords(
        abstractHtmlToText(
          (content as Record<string, string>)[section] ?? "",
        ),
      );
      total += wordCount;
      const limit = sectionLimits[section];
      if (limit != null && wordCount > limit) {
        errors.push(`${section} (${wordCount} words, limit ${limit})`);
      }
    }
    if (config.globalWordLimit != null && total > config.globalWordLimit) {
      errors.push(`total (${total} words, limit ${config.globalWordLimit})`);
    }
  }

  if (errors.length > 0) {
    throw new AppException(
      ErrorCodes.ABSTRACT_WORD_LIMIT_EXCEEDED,
      `Word limit exceeded: ${errors.join(", ")}`,
      422,
      { fields: errors },
    );
  }
}

export function validateAbstractContent(
  raw: AbstractContent,
  config: AbstractConfigRow,
): AbstractContent {
  const content = sanitizeAbstractContent(raw);
  validateMode(content.mode, config.submissionMode);
  validateContentPresence(content);
  validateWordLimits(content, config);
  return content;
}

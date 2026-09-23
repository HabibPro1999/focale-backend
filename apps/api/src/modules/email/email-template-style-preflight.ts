import {
  EmailFontSizeSchema,
  EmailLineHeightSchema,
  EmailTextAlignSchema,
  TiptapDocumentSchema,
  type TiptapDocument,
} from "@app/contracts";

export interface EmailTemplateStyleChange {
  path: string;
  attribute: "textAlign" | "fontSize" | "lineHeight";
  action: "removed" | "normalized";
}

export interface EmailTemplateStylePreflight {
  content: TiptapDocument | null;
  changes: EmailTemplateStyleChange[];
  validationIssues: string[];
}

/** Remove invalid editor style attrs and normalize legacy unitless lengths. */
export function preflightEmailTemplateContent(
  content: unknown,
): EmailTemplateStylePreflight {
  const changes: EmailTemplateStyleChange[] = [];

  const cleanNode = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => cleanNode(item, `${path}[${index}]`));
    }
    if (!value || typeof value !== "object") return value;

    const node = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = { ...node };

    if (node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs)) {
      const attrs = { ...(node.attrs as Record<string, unknown>) };
      for (const attribute of ["textAlign", "fontSize", "lineHeight"] as const) {
        const value = attrs[attribute];
        if (value == null) continue;

        const parsed =
          attribute === "textAlign"
            ? EmailTextAlignSchema.safeParse(value)
            : attribute === "fontSize"
              ? EmailFontSizeSchema.safeParse(value)
              : EmailLineHeightSchema.safeParse(value);
        if (!parsed.success) {
          delete attrs[attribute];
          changes.push({ path, attribute, action: "removed" });
        } else if (parsed.data !== value) {
          attrs[attribute] = parsed.data;
          changes.push({ path, attribute, action: "normalized" });
        }
      }
      cleaned.attrs = attrs;
    }

    if (Array.isArray(node.content)) {
      cleaned.content = node.content.map((child, index) =>
        cleanNode(child, `${path}.content[${index}]`),
      );
    }
    return cleaned;
  };

  const cleanedContent = cleanNode(content, "content");
  const parsed = TiptapDocumentSchema.safeParse(cleanedContent);
  return {
    content: parsed.success ? parsed.data : null,
    changes,
    validationIssues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message),
  };
}

import {
  EmailFontSizeSchema,
  EmailLineHeightSchema,
  EmailTextAlignSchema,
  TiptapDocumentSchema,
  type TiptapDocument,
} from "@app/contracts";
import {
  compileMjmlToHtml,
  extractPlainText,
  renderTemplateToMjml,
} from "@app/integrations";

export interface EmailTemplateStyleChange {
  path: string;
  attribute: "textAlign" | "fontSize" | "lineHeight";
  action: "removed" | "normalized";
}

export interface EmailTemplateStylePreflight {
  content: TiptapDocument | null;
  changes: EmailTemplateStyleChange[];
  suspiciousAttributes: string[];
  validationIssues: string[];
}

export interface EmailTemplatePreflightRow {
  id: string;
  name: string;
  content: unknown;
  updatedAt: Date;
}

export interface EmailTemplatePreflightUpdate {
  content: TiptapDocument;
  mjmlContent: string;
  htmlContent: string;
  plainContent: string;
}

export interface EmailTemplatePreflightReport {
  id: string;
  name: string;
  changes: EmailTemplateStyleChange[];
  suspiciousAttributes: string[];
  validationIssues: string[];
  status: "would-update" | "updated" | "conflict" | "manual-review";
  detail?: string;
}

export interface EmailTemplatePreflightSummary {
  scanned: number;
  wouldUpdate: number;
  updated: number;
  manualReview: number;
  conflicts: number;
  reports: EmailTemplatePreflightReport[];
}

export type EmailTemplatePreflightWriter = (
  row: EmailTemplatePreflightRow,
  update: EmailTemplatePreflightUpdate,
) => Promise<unknown>;

const SUSPICIOUS_ATTRIBUTE_VALUE = /["'<]|mj-/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findSuspiciousAttributePaths(document: unknown): string[] {
  const paths: string[] = [];
  const scanValue = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (SUSPICIOUS_ATTRIBUTE_VALUE.test(value)) paths.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => scanValue(item, `${path}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        scanValue(item, `${path}.${key}`);
      }
    }
  };

  const visitNode = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitNode(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;

    if (isRecord(value.attrs)) {
      for (const [attribute, attributeValue] of Object.entries(value.attrs)) {
        scanValue(attributeValue, `${path}.attrs.${attribute}`);
      }
    }
    if (Array.isArray(value.content)) {
      visitNode(value.content, `${path}.content`);
    }
    if (Array.isArray(value.marks)) {
      visitNode(value.marks, `${path}.marks`);
    }
  };

  visitNode(document, "content");
  return paths;
}

/** Remove invalid editor style attrs and normalize legacy unitless lengths. */
export function preflightEmailTemplateContent(
  content: unknown,
): EmailTemplateStylePreflight {
  const changes: EmailTemplateStyleChange[] = [];
  const suspiciousAttributes = findSuspiciousAttributePaths(content);

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
    suspiciousAttributes,
    validationIssues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message),
  };
}

/** Scan stored templates and refresh derived email fields when attrs look unsafe. */
export async function runEmailTemplateStylePreflight(
  rows: readonly EmailTemplatePreflightRow[],
  options: { apply: boolean; update?: EmailTemplatePreflightWriter },
): Promise<EmailTemplatePreflightSummary> {
  const summary: EmailTemplatePreflightSummary = {
    scanned: rows.length,
    wouldUpdate: 0,
    updated: 0,
    manualReview: 0,
    conflicts: 0,
    reports: [],
  };

  for (const row of rows) {
    const preflight = preflightEmailTemplateContent(row.content);
    if (!preflight.content) {
      summary.manualReview += 1;
      summary.reports.push({
        id: row.id,
        name: row.name,
        changes: preflight.changes,
        suspiciousAttributes: preflight.suspiciousAttributes,
        validationIssues: preflight.validationIssues,
        status: "manual-review",
        detail: "content does not pass the email template schema after style cleanup",
      });
      continue;
    }

    if (
      preflight.changes.length === 0 &&
      preflight.suspiciousAttributes.length === 0
    ) {
      continue;
    }

    const report: EmailTemplatePreflightReport = {
      id: row.id,
      name: row.name,
      changes: preflight.changes,
      suspiciousAttributes: preflight.suspiciousAttributes,
      validationIssues: [],
      status: "would-update",
    };
    summary.reports.push(report);

    try {
      const mjmlContent = renderTemplateToMjml(preflight.content);
      const { html: htmlContent } = await compileMjmlToHtml(mjmlContent);
      const update: EmailTemplatePreflightUpdate = {
        content: preflight.content,
        mjmlContent,
        htmlContent,
        plainContent: extractPlainText(preflight.content),
      };

      if (!options.apply) {
        summary.wouldUpdate += 1;
        continue;
      }

      if (!options.update) {
        throw new Error("No email template update function was provided");
      }
      const updated = await options.update(row, update);
      if (!updated) {
        summary.conflicts += 1;
        report.status = "conflict";
        report.detail = "template changed after the scan";
        continue;
      }

      summary.updated += 1;
      report.status = "updated";
    } catch {
      summary.manualReview += 1;
      report.status = "manual-review";
      report.detail = "re-render or update failed";
    }
  }

  return summary;
}

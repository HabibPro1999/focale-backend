import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import {
  getAbstractsExportPlan,
  iterateAbstractsForExport,
  withExportStatementTimeout,
  type AdminAbstractRow,
} from "@app/db";
import { reviewScoreSpread } from "./abstracts.admin.service";
import {
  formatDateTime,
  formatFileDate,
  getAbstractTitle,
  getAuthorLine,
} from "@app/shared";
import {
  ABSTRACT_STATUS_LABELS_FR,
  ABSTRACT_TYPE_LABELS_FR,
} from "@app/contracts";
import type { ExportAbstractsQuery } from "@app/contracts";
import type { ExportDownload } from "../../core/exports/stream-io";
import {
  ColumnStyles,
  RowPacer,
  XLSX_CONTENT_TYPE,
  createXlsxWriter,
} from "../../core/exports/xlsx-stream";

function averageScoreOf(
  reviews: Array<{ score: number | null }>,
): number | null {
  const scores = reviews
    .map((review) => review.score)
    .filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

const BASE_COLUMNS = [
  "Code",
  "Titre",
  "Type demandé",
  "Type final",
  "Statut",
  "Thèmes",
  "Auteur (nom)",
  "Auteur (prénom)",
  "Email",
  "Téléphone",
  "Affiliation",
  "Auteurs (tous)",
  "Note moyenne",
  "Nb évaluateurs",
  "Note min",
  "Note max",
  "Écart",
];

const TRAILING_COLUMNS = ["Présenté le", "Soumis le", "Modifié le (auteur)"];

const COLUMN_WIDTHS: Record<string, number> = {
  Code: 12,
  Titre: 40,
  "Type demandé": 18,
  "Type final": 18,
  Statut: 18,
  Thèmes: 25,
  "Auteur (nom)": 18,
  "Auteur (prénom)": 18,
  Email: 28,
  Téléphone: 16,
  Affiliation: 25,
  "Auteurs (tous)": 35,
  "Note moyenne": 13,
  "Nb évaluateurs": 14,
  "Note min": 10,
  "Note max": 10,
  Écart: 10,
  "Présenté le": 18,
  "Soumis le": 18,
  "Modifié le (auteur)": 20,
};

const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

/**
 * The abstracts workbook (admin list filters): the filtered ids and the
 * reviewer-column count are read now, the abstracts are then streamed a page
 * of ids at a time.
 */
export async function prepareAbstractsExport(
  eventId: string,
  query: ExportAbstractsQuery,
  eventSlug: string,
): Promise<ExportDownload> {
  const { ids, maxReviews } = await withExportStatementTimeout((tx) =>
    getAbstractsExportPlan(eventId, query, tx),
  );
  return {
    filename: `${eventSlug}-resumes-${formatFileDate()}.xlsx`,
    contentType: XLSX_CONTENT_TYPE,
    write: (out, signal) =>
      writeAbstractsWorkbook(out, signal, maxReviews, iterateAbstractsForExport(ids, { signal })),
  };
}

function rowValues(abstract: AdminAbstractRow, maxReviews: number): ExcelJS.CellValue[] {
  const scoredCount = abstract.reviews.filter((review) => review.scoredAt !== null).length;
  const spread = reviewScoreSpread(abstract.reviews);
  const average = averageScoreOf(abstract.reviews);

  const values: ExcelJS.CellValue[] = [
    abstract.code ?? "",
    getAbstractTitle(abstract.content),
    ABSTRACT_TYPE_LABELS_FR[abstract.requestedType],
    abstract.finalType ? ABSTRACT_TYPE_LABELS_FR[abstract.finalType] : "—",
    ABSTRACT_STATUS_LABELS_FR[abstract.status],
    abstract.themes
      .map((theme) => theme.label)
      .filter(Boolean)
      .join(", "),
    abstract.authorLastName,
    abstract.authorFirstName,
    abstract.authorEmail,
    abstract.authorPhone,
    abstract.authorAffiliation ?? "",
    getAuthorLine(abstract),
    average ?? "",
    scoredCount,
    spread.min ?? "",
    spread.max ?? "",
    spread.spread ?? "",
  ];

  // Reviews added after the column count was read have no column.
  for (let k = 0; k < maxReviews; k++) {
    const review = abstract.reviews[k];
    values.push(review ? review.reviewer.name || review.reviewer.email : "");
    values.push(review ? (review.score ?? "") : "");
  }

  values.push(
    abstract.presentedAt ? formatDateTime(abstract.presentedAt) : "",
    formatDateTime(abstract.createdAt),
    abstract.lastEditedAt ? formatDateTime(abstract.lastEditedAt) : "",
  );
  return values;
}

async function writeAbstractsWorkbook(
  out: Writable,
  signal: AbortSignal,
  maxReviews: number,
  pages: AsyncIterable<AdminAbstractRow[]>,
): Promise<void> {
  const reviewColumns: string[] = [];
  for (let k = 1; k <= maxReviews; k++) {
    reviewColumns.push(`Évaluateur ${k}`, `Note ${k}`);
  }
  const columns = [...BASE_COLUMNS, ...reviewColumns, ...TRAILING_COLUMNS];

  const workbook = createXlsxWriter(out, signal);
  const sheet = workbook.addWorksheet("Résumés", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  columns.forEach((column, index) => {
    const width =
      COLUMN_WIDTHS[column] ??
      (column.startsWith("Évaluateur") ? 22 : column.startsWith("Note") ? 10 : 18);
    sheet.getColumn(index + 1).width = width;
  });

  const headerRow = sheet.addRow(columns);
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.border = BORDER;
  });
  headerRow.commit();

  const cellStyles = new ColumnStyles(() => ({ border: BORDER }));
  const pacer = new RowPacer(out, signal, sheet);
  for await (const page of pages) {
    for (const abstract of page) {
      const row = sheet.addRow(rowValues(abstract, maxReviews));
      row.eachCell((cell, column) => {
        cell.style = cellStyles.for(column, cell.type);
      });
      row.commit();
      await pacer.row();
    }
    await pacer.pageDone();
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}

import ExcelJS from "exceljs";
import { prisma } from "@/database/client.js";
import { escapeExcelRow } from "@modules/reports/excel-safety.js";
import { formatDateTime } from "@modules/reports/excel-generator.js";
import {
  buildAdminAbstractsWhere,
  getTitle,
  reviewScoreSpread,
} from "./abstracts.admin.service.js";
import { getAuthorLine } from "./abstracts.book.service.js";
import {
  ABSTRACT_STATUS_LABELS_FR,
  ABSTRACT_TYPE_LABELS_FR,
} from "./abstracts.constants.js";
import type { ExportAbstractsQuery } from "./abstracts.schema.js";

function averageScoreOf(reviews: Array<{ score: number | null }>): number | null {
  const scores = reviews
    .map((review) => review.score)
    .filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export async function exportAbstractsWorkbook(
  eventId: string,
  query: ExportAbstractsQuery,
  eventSlug: string,
): Promise<{ filename: string; data: Buffer }> {
  const where = buildAdminAbstractsWhere(eventId, query);

  const abstracts = await prisma.abstract.findMany({
    where,
    include: {
      themes: { include: { theme: { select: { label: true } } } },
      reviews: {
        where: { active: true },
        include: { reviewer: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ code: "asc" }, { createdAt: "desc" }],
  });

  const maxReviews = abstracts.reduce(
    (max, abstract) => Math.max(max, abstract.reviews.length),
    0,
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Résumés");

  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 11,
  };
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };

  const baseColumns = [
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

  const reviewColumns: string[] = [];
  for (let k = 1; k <= maxReviews; k++) {
    reviewColumns.push(`Évaluateur ${k}`, `Note ${k}`);
  }

  const trailingColumns = ["Présenté le", "Soumis le", "Modifié le (auteur)"];

  const columns = [...baseColumns, ...reviewColumns, ...trailingColumns];

  const headerRow = sheet.addRow(escapeExcelRow(columns));
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
  });

  for (const abstract of abstracts) {
    const scoredCount = abstract.reviews.filter(
      (review) => review.scoredAt !== null,
    ).length;
    const spread = reviewScoreSpread(abstract.reviews);
    const average = averageScoreOf(abstract.reviews);

    const rowValues: ExcelJS.CellValue[] = [
      abstract.code ?? "",
      getTitle(abstract.content),
      ABSTRACT_TYPE_LABELS_FR[abstract.requestedType],
      abstract.finalType ? ABSTRACT_TYPE_LABELS_FR[abstract.finalType] : "—",
      ABSTRACT_STATUS_LABELS_FR[abstract.status],
      abstract.themes
        .map((link) => link.theme.label)
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

    for (let k = 0; k < maxReviews; k++) {
      const review = abstract.reviews[k];
      rowValues.push(
        review ? review.reviewer.name || review.reviewer.email : "",
      );
      rowValues.push(review ? (review.score ?? "") : "");
    }

    rowValues.push(
      abstract.presentedAt ? formatDateTime(abstract.presentedAt) : "",
      formatDateTime(abstract.createdAt),
      abstract.lastEditedAt ? formatDateTime(abstract.lastEditedAt) : "",
    );

    const row = sheet.addRow(escapeExcelRow(rowValues));
    row.eachCell((cell) => {
      cell.border = border;
    });
  }

  const columnWidths: Record<string, number> = {
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

  columns.forEach((column, index) => {
    const width =
      columnWidths[column] ??
      (column.startsWith("Évaluateur") ? 22 : column.startsWith("Note") ? 10 : 18);
    sheet.getColumn(index + 1).width = width;
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const timestamp = new Date().toISOString().split("T")[0];

  return {
    filename: `${eventSlug}-resumes-${timestamp}.xlsx`,
    data: buffer,
  };
}

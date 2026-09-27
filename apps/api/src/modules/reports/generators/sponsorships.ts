import { getSponsorshipsReportData, withExportStatementTimeout } from "@app/db";
import { escapeExcelRow } from "../excel-safety";
import { addTitleBlock, dateStamp, formatDateTime, newWorkbook, styleHeaderRow, THIN_BORDER, toXlsxBuffer } from "../excel-style";

function getLabTotalKey(labName: string): string {
  return labName.trim().toLowerCase();
}

function formatRegistrationLabel(
  registration: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null,
): string {
  if (!registration) return "Registration deleted";

  const name = [registration.firstName, registration.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name ? `${name} <${registration.email}>` : registration.email;
}

export async function generateSponsorshipsReport(
  eventId: string,
  filters?: { status?: string; search?: string },
): Promise<{ filename: string; data: Buffer }> {
  const { event, currency, accessItems, sponsorships } =
    await withExportStatementTimeout((tx) => getSponsorshipsReportData(eventId, filters, tx));

  const accessNameById = new Map(accessItems.map((item) => [item.id, item.name]));

  const workbook = newWorkbook();

  const sheet = workbook.addWorksheet("Sponsorships");

  addTitleBlock(sheet, {
    title: event?.name ?? "Sponsorships", lastCol: "R", size: 16, generatedLabel: "Report generated:",
  });

  const columns = [
    "Code",
    "Laboratory",
    "Contact",
    "Lab Email",
    "Lab Phone",
    "Lab Total Amount",
    "Beneficiary",
    "Beneficiary Email",
    "Beneficiary Phone",
    "Beneficiary Address",
    "Amount",
    "Currency",
    "Status",
    "Created At",
    "Coverage",
    "Linked Registrations",
    "Amount Applied",
    "Applied At",
  ];

  const headerRow = sheet.addRow(columns);
  styleHeaderRow(headerRow);

  const sortedSponsorships = [...sponsorships].sort((a, b) => {
    const byLab = a.batch.labName.localeCompare(b.batch.labName, "fr", {
      sensitivity: "base",
    });
    if (byLab !== 0) return byLab;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const labTotals = sponsorships.reduce((totals, sponsorship) => {
    const key = getLabTotalKey(sponsorship.batch.labName);
    totals.set(key, (totals.get(key) ?? 0) + sponsorship.totalAmount);
    return totals;
  }, new Map<string, number>());

  for (const sponsorship of sortedSponsorships) {
    const coveredAccessNames = sponsorship.coveredAccessIds
      .map((accessId) => accessNameById.get(accessId))
      .filter((name): name is string => Boolean(name));

    const coverageParts = [
      sponsorship.coversBasePrice ? "Base registration" : null,
      ...coveredAccessNames,
    ].filter((value): value is string => Boolean(value));

    const linkedRegistrations = sponsorship.usages
      .map((usage) => formatRegistrationLabel(usage.registration))
      .join(" | ");
    const amountApplied = sponsorship.usages.reduce(
      (sum, usage) => sum + usage.amountApplied,
      0,
    );
    const appliedDates = sponsorship.usages
      .map((usage) => formatDateTime(usage.appliedAt))
      .join(" | ");

    const dataRow = sheet.addRow(
      escapeExcelRow([
        sponsorship.code,
        sponsorship.batch.labName,
        sponsorship.batch.contactName,
        sponsorship.batch.email,
        sponsorship.batch.phone ?? "",
        labTotals.get(getLabTotalKey(sponsorship.batch.labName)) ??
          sponsorship.totalAmount,
        sponsorship.beneficiaryName,
        sponsorship.beneficiaryEmail,
        sponsorship.beneficiaryPhone ?? "",
        sponsorship.beneficiaryAddress ?? "",
        sponsorship.totalAmount,
        currency,
        sponsorship.status,
        formatDateTime(sponsorship.createdAt),
        coverageParts.join("; "),
        linkedRegistrations,
        amountApplied,
        appliedDates,
      ]),
    );

    dataRow.eachCell((cell) => {
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: "top", wrapText: true };
    });
    dataRow.getCell(6).numFmt = "#,##0";
    dataRow.getCell(11).numFmt = "#,##0";
    dataRow.getCell(17).numFmt = "#,##0";
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: columns.length },
  };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];

  const widths = [
    16, 28, 24, 28, 18, 18, 28, 28, 18, 30, 14, 12, 14, 22, 40, 40, 16, 24,
  ];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  const buffer = await toXlsxBuffer(workbook);
  const timestamp = dateStamp();

  return {
    filename: `${event?.slug ?? "event"}-sponsorships-${timestamp}.xlsx`,
    data: buffer,
  };
}

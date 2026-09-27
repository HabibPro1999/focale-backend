import type ExcelJS from "exceljs";
import JSZip from "jszip";
import { getCheckInReportData, withExportStatementTimeout } from "@app/db";
import { escapeExcelRow } from "../excel-safety";
import { addTitleBlock, dateStamp, newWorkbook, styleHeaderRow, THIN_BORDER, toXlsxBuffer } from "../excel-style";
import { PAYMENT_STATUS_FR } from "../registrations-export/labels";

function buildCheckInSheet(
  sheet: ExcelJS.Worksheet,
  title: string,
  rows: {
    referenceNumber: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    checkedIn: boolean;
    checkedInAt: Date | null;
  }[],
): void {
  addTitleBlock(sheet, {
    title, lastCol: "I", size: 14, generatedLabel: "Generated:",
  });

  const columns = [
    "Ref #",
    "Last Name",
    "First Name",
    "Email",
    "Phone",
    "Payment Status",
    "Checked In",
    "Check-in Date",
    "Check-in Time",
  ];
  const headerRow = sheet.addRow(columns);
  styleHeaderRow(headerRow);

  // Sort: checked-in first, then by submission order
  const sorted = [...rows].sort((a, b) => {
    if (a.checkedIn && !b.checkedIn) return -1;
    if (!a.checkedIn && b.checkedIn) return 1;
    return 0;
  });

  for (const r of sorted) {
    let dateStr = "";
    let timeStr = "";
    if (r.checkedInAt) {
      dateStr = r.checkedInAt.toLocaleDateString("fr-FR");
      timeStr = r.checkedInAt.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    const dataRow = sheet.addRow(
      escapeExcelRow([
        r.referenceNumber ?? "",
        r.lastName ?? "",
        r.firstName ?? "",
        r.email,
        r.phone ?? "",
        PAYMENT_STATUS_FR[r.paymentStatus] ?? r.paymentStatus,
        r.checkedIn ? "✓" : "✗",
        dateStr,
        timeStr,
      ]),
    );

    dataRow.eachCell((cell) => {
      cell.border = THIN_BORDER;
    });

    const checkedInCell = dataRow.getCell(7);
    checkedInCell.font = {
      bold: true,
      color: { argb: r.checkedIn ? "FF22C55E" : "FFEF4444" },
    };
  }

  sheet.autoFilter = {
    from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: columns.length },
  };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];

  const widths = [14, 20, 20, 34, 18, 20, 12, 16, 12];
  widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));
}

async function checkInWorkbook(
  title: string,
  rows: Parameters<typeof buildCheckInSheet>[2],
): Promise<Buffer> {
  const workbook = newWorkbook();
  buildCheckInSheet(workbook.addWorksheet("Check-in"), title, rows);
  return toXlsxBuffer(workbook);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export async function generateCheckInReport(
  eventId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { event, accessItems, registrations } = await withExportStatementTimeout((tx) =>
    getCheckInReportData(eventId, tx),
  );

  const zip = new JSZip();
  const timestamp = dateStamp();
  const eventSlug = event?.slug ?? "event";
  const eventName = event?.name ?? "Event";

  // ── 1. Global check-in sheet ──────────────────────────────────────────────

  const globalBuffer = await checkInWorkbook(
    `${eventName} — Global Check-in`,
    registrations.map((r) => ({
      referenceNumber: r.referenceNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      paymentStatus: r.paymentStatus,
      checkedIn: r.checkedInAt !== null,
      checkedInAt: r.checkedInAt,
    })),
  );

  zip.file(`${eventSlug}-global-checkin.xlsx`, globalBuffer);

  // ── 2. Per-access check-in sheets ─────────────────────────────────────────
  // ponytail: two access names slugifying to the same string overwrite each
  // other's zip entry (last write wins) — kept as legacy behaviour.

  for (const access of accessItems) {
    const accessRegs = registrations.filter((r) =>
      r.accessTypeIds.includes(access.id),
    );

    const buf = await checkInWorkbook(
      `${access.name} — Check-in`,
      accessRegs.map((r) => {
        const aci = r.accessCheckIns.find((c) => c.accessId === access.id);
        return {
          referenceNumber: r.referenceNumber,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          phone: r.phone,
          paymentStatus: r.paymentStatus,
          checkedIn: aci !== undefined,
          checkedInAt: aci?.checkedInAt ?? null,
        };
      }),
    );

    zip.file(`${slugify(access.name)}-checkin.xlsx`, buf);
  }

  const zipBuffer = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

  return {
    filename: `${eventSlug}-checkin-${timestamp}.zip`,
    data: zipBuffer,
  };
}

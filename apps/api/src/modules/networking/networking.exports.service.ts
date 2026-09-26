import { BadRequestException, Injectable } from "@nestjs/common";
import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import {
  networkingMatchExportPages,
  networkingMeetingExportPages,
  networkingParticipantExportPages,
  networkingSectorMetrics,
  networkingStore,
  type NetworkingExportPerson,
  type NetworkingRow,
} from "@app/db";
import { generateNetworkingReportPdf } from "@app/integrations";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext } from "./networking.service";
import { CSV_BOM, toCsv, toCsvLine } from "@app/shared";
import { downloadBody, writeChunk } from "../../core/exports/stream-io";
import {
  ColumnStyles,
  RowPacer,
  XLSX_CONTENT_TYPE,
  createXlsxWriter,
} from "../../core/exports/xlsx-stream";
const csv = (headers: string[], rows: unknown[][]) => toCsv([headers, ...rows]);
const escapeIcs = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
const dateIcs = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
function foldIcs(line: string) {
  let output = "",
    part = "";
  for (const character of line) {
    if (Buffer.byteLength(part + character) > 73) {
      output += part + "\r\n ";
      part = "";
    }
    part += character;
  }
  return output + part;
}
@Injectable()
export class NetworkingExportsService {
  constructor(
    private readonly social: NetworkingSocialService,
    private readonly meetings: NetworkingMeetingsService,
  ) {}
  async calendar(ctx: NetworkingContext) {
    const rows = (await this.meetings.allMeetings(ctx)).filter((m) =>
      ["CONFIRMED", "COMPLETED", "CANCELLED"].includes(m.status),
    );
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Focale//B2B Networking//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ];
    for (const row of rows) {
      const contact =
        row.requesterId === ctx.profile.id ? row.recipient : row.requester;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${row.id}@networking.focale`,
        `DTSTAMP:${dateIcs(row.updatedAt)}`,
        `DTSTART:${dateIcs(row.startsAt)}`,
        `DTEND:${dateIcs(row.endsAt)}`,
        `SEQUENCE:${row.revision}`,
        `STATUS:${row.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"}`,
        `SUMMARY:${escapeIcs(`Meeting with ${contact?.firstName ?? ""} ${contact?.lastName ?? ""}`)}`,
        `LOCATION:${escapeIcs(`${row.table?.name ?? ""} ${row.table?.location ?? ""}`)}`,
        `DESCRIPTION:${escapeIcs(row.message)}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldIcs).join("\r\n") + "\r\n";
  }
  async connections(ctx: NetworkingContext) {
    const items = await this.social.allConnections(ctx);
    return csv(
      ["First name", "Last name", "Company", "Role", "Sector", "Website"],
      items.map(({ profile: p }) => [
        p.firstName,
        p.lastName,
        p.company,
        p.jobTitle,
        p.sector,
        p.website,
      ]),
    );
  }
  async personal(ctx: NetworkingContext) {
    const store = networkingStore();
    const [interests, messages, reports, blocks, notifications] =
      await Promise.all([
        store.all("interests", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
        }),
        store.all("messages", {
          eventId: ctx.event.id,
          senderId: ctx.profile.id,
        }),
        store.all("reports", {
          eventId: ctx.event.id,
          reporterId: ctx.profile.id,
        }),
        store.all("blocks", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
        }),
        store.all("notifications", {
          eventId: ctx.event.id,
          profileId: ctx.profile.id,
        }),
      ]);
    return {
      exportedAt: new Date(),
      profile: ctx.profile,
      interests,
      messages,
      reports: reports.map(({ resolvedBy, note, ...report }) => report),
      blocks,
      notifications,
      connections: await this.social.allConnections(ctx),
      meetings: await this.meetings.allMeetings(ctx),
    };
  }
  /**
   * An organizer export (4.9): CSV and XLSX are written into the response
   * body as it is read, from SQL pages of 500 rows (ids in export order
   * first); nothing is buffered beyond one page. A PDF is built in memory
   * (pdf-lib), from the same pages. Erased profiles are tombstones (4.6): the
   * participant list leaves them out, other rows name them by id.
   */
  async admin(event: NetworkingRow<"events">, kind: string, format: string) {
    if (
      !["participants", "matches", "meetings", "sectors"].includes(kind) ||
      !["csv", "xlsx", "pdf"].includes(format)
    )
      throw new BadRequestException(
        "Choose participants, matches, meetings or sectors and csv, xlsx or pdf",
      );
    if (kind === "meetings") await this.meetings.expire(event.id);
    const { headers, pages } = adminTable(event.id, kind as AdminExportKind);
    if (format === "pdf") {
      const rows: unknown[][] = [];
      for await (const page of pages()) rows.push(...page);
      return {
        body: await generateNetworkingReportPdf(`${event.name} — ${kind}`, headers, rows),
        contentType: "application/pdf",
        kind,
        format,
      };
    }
    const csvFile = format === "csv";
    const contentType = csvFile ? "text/csv; charset=utf-8" : XLSX_CONTENT_TYPE;
    return {
      body: downloadBody({
        filename: `networking-${kind}.${format}`,
        contentType,
        write: (out, signal) =>
          csvFile
            ? writeAdminCsv(out, signal, headers, pages(signal))
            : writeAdminWorkbook(out, signal, kind, headers, pages(signal)),
      }),
      contentType,
      kind,
      format,
    };
  }
}

type AdminExportKind = "participants" | "matches" | "meetings" | "sectors";
/** A participant as the organizer exports name them: "First Last" when listed, else the id. */
const exportName = (id: string, person: NetworkingExportPerson) => (person ? `${person.firstName} ${person.lastName}` : id);

/** An export's header row and its rows, page by page. */
function adminTable(eventId: string, kind: AdminExportKind): { headers: string[]; pages: (signal?: AbortSignal) => AsyncIterable<unknown[][]> } {
  const mapped = <T>(source: (options: { signal?: AbortSignal }) => AsyncIterable<T[]>, cells: (row: T) => unknown[]) =>
    async function* (signal?: AbortSignal) {
      for await (const page of source({ signal })) yield page.map(cells);
    };
  if (kind === "participants")
    return {
      headers: ["Name", "Email", "Company", "Role", "Sector", "Status", "Visible", "Last active", "Swipes", "Matches", "Messages", "Planned meetings"],
      pages: mapped((options) => networkingParticipantExportPages(eventId, options), (p) => [
        `${p.firstName} ${p.lastName}`, p.email, p.company, p.jobTitle, p.sector, p.status, p.visible,
        p.lastActiveAt?.toISOString(), p.swipes, p.matches, p.messages, p.meetings,
      ]),
    };
  if (kind === "matches")
    return {
      headers: ["Connection ID", "Participant A", "Company A", "Participant B", "Company B", "Created at"],
      pages: mapped((options) => networkingMatchExportPages(eventId, options), (c) => [
        c.id, exportName(c.profileAId, c.a), c.a?.company ?? "", exportName(c.profileBId, c.b), c.b?.company ?? "", c.createdAt.toISOString(),
      ]),
    };
  if (kind === "meetings")
    return {
      headers: ["Meeting ID", "Requester", "Recipient", "Start UTC", "End UTC", "Table", "Status", "Message"],
      pages: mapped((options) => networkingMeetingExportPages(eventId, options), (m) => [
        m.id, exportName(m.requesterId, m.requester), exportName(m.recipientId, m.recipient),
        m.startsAt.toISOString(), m.endsAt.toISOString(), m.tableId ? m.tableName ?? undefined : "", m.status, m.message,
      ]),
    };
  return {
    headers: ["Sector", "Participants", "Matches", "Meetings"],
    // A handful of rows: the same aggregates as the organizer analytics.
    pages: async function* () {
      yield (await networkingSectorMetrics(eventId, { unspecified: "Unspecified" })).map((s) => [s.sector, s.participants, s.connections, s.meetings]);
    },
  };
}

async function writeAdminCsv(out: Writable, signal: AbortSignal, headers: string[], pages: AsyncIterable<unknown[][]>) {
  await writeChunk(out, CSV_BOM + toCsvLine(headers), signal);
  for await (const page of pages) await writeChunk(out, page.map(toCsvLine).join(""), signal);
  signal.throwIfAborted();
  out.end();
}

/** Rows between two waits on the zip and the client. */
const WORKBOOK_PAGE_ROWS = 500;

async function writeAdminWorkbook(
  out: Writable,
  signal: AbortSignal,
  kind: string,
  headers: string[],
  pages: AsyncIterable<unknown[][]>,
): Promise<void> {
  const workbook = createXlsxWriter(out, signal);
  workbook.creator = "Focale";
  const sheet = workbook.addWorksheet(kind, { views: [{ state: "frozen", ySplit: 1 }] });
  // Column settings first: a streamed sheet writes them with its first row,
  // and new cells take the column's alignment.
  const alignment: Partial<ExcelJS.Alignment> = { wrapText: true, vertical: "top" };
  for (let column = 1; column <= headers.length; column++) {
    sheet.getColumn(column).width = 24;
    sheet.getColumn(column).alignment = alignment;
  }
  const header = sheet.addRow(headers);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1E3A5F" },
  };
  header.commit();

  const cellStyles = new ColumnStyles(() => ({ alignment }));
  const pacer = new RowPacer(out, signal, sheet);
  let count = 0;
  for await (const page of pages) {
    for (const values of page) {
      const row = sheet.addRow(values.map((value) => value ?? ""));
      row.eachCell((cell, column) => {
        cell.style = cellStyles.for(column, cell.type);
      });
      row.commit();
      await pacer.row();
      if (++count % WORKBOOK_PAGE_ROWS === 0) await pacer.pageDone();
    }
  }
  // Written with the sheet's closing part, so it can follow the rows.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: count + 1, column: headers.length },
  };

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}

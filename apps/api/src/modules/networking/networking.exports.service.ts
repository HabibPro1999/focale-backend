import { BadRequestException, Injectable } from "@nestjs/common";
import type ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import { networkingMeetingIs, networkingStore, type NetworkingRow } from "@app/db";
import { generateNetworkingReportPdf } from "@app/integrations";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext } from "./networking.service";
import { toCsv } from "@app/shared";
import { downloadBody } from "../../core/exports/stream-io";
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
    private readonly adminService: NetworkingAdminService,
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
  async admin(event: NetworkingRow<"events">, kind: string, format: string) {
    if (
      !["participants", "matches", "meetings", "sectors"].includes(kind) ||
      !["csv", "xlsx", "pdf"].includes(format)
    )
      throw new BadRequestException(
        "Choose participants, matches, meetings or sectors and csv, xlsx or pdf",
      );
    const store = networkingStore();
    // Erased profiles are tombstones with nothing to export.
    const profiles = (await store.all("profiles", { eventId: event.id })).filter((profile) => !profile.erasedAt);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const name = (id: string) => {
      const p = byId.get(id);
      return p ? `${p.firstName} ${p.lastName}` : id;
    };
    let headers: string[], rows: unknown[][];
    if (kind === "participants") {
      headers = [
        "Name",
        "Email",
        "Company",
        "Role",
        "Sector",
        "Status",
        "Visible",
        "Last active",
        "Swipes",
        "Matches",
        "Messages",
        "Planned meetings",
      ];
      const [interests, connections, messages, meetings, audit] =
        await Promise.all([
          store.all("interests", { eventId: event.id }),
          store.all("connections", { eventId: event.id }),
          store.all("messages", { eventId: event.id }),
          store.all("meetings", { eventId: event.id }),
          store.all("audit", { eventId: event.id }),
        ]);
      const counts = new Map(
        profiles.map((p) => [
          p.id,
          { swipes: 0, matches: 0, messages: 0, meetings: 0 },
        ]),
      );
      const swipeHistory = audit.filter(
        (row) => row.action === "SWIPE_LIKE" || row.action === "SWIPE_PASS",
      );
      const auditedPairs = new Set(
        swipeHistory.map((row) => `${row.actorId}:${row.targetId}`),
      );
      for (const value of swipeHistory) {
        const count = counts.get(value.actorId);
        if (count) count.swipes++;
      }
      for (const value of interests)
        if (!auditedPairs.has(`${value.profileId}:${value.targetId}`)) {
          const count = counts.get(value.profileId);
          if (count) count.swipes++;
        }
      for (const value of connections)
        for (const id of [value.profileAId, value.profileBId]) {
          const count = counts.get(id);
          if (count) count.matches++;
        }
      for (const value of messages) {
        const count = counts.get(value.senderId);
        if (count) count.messages++;
      }
      for (const value of meetings)
        if (networkingMeetingIs(value.status, "booked"))
          for (const id of [value.requesterId, value.recipientId]) {
            const count = counts.get(id);
            if (count) count.meetings++;
          }
      rows = profiles.map((p) => [
        name(p.id),
        p.email,
        p.company,
        p.jobTitle,
        p.sector,
        p.status,
        p.visible,
        p.lastActiveAt?.toISOString(),
        counts.get(p.id)?.swipes ?? 0,
        counts.get(p.id)?.matches ?? 0,
        counts.get(p.id)?.messages ?? 0,
        counts.get(p.id)?.meetings ?? 0,
      ]);
    } else if (kind === "matches") {
      headers = [
        "Connection ID",
        "Participant A",
        "Company A",
        "Participant B",
        "Company B",
        "Created at",
      ];
      rows = (await store.all("connections", { eventId: event.id })).map(
        (c) => [
          c.id,
          name(c.profileAId),
          byId.get(c.profileAId)?.company ?? "",
          name(c.profileBId),
          byId.get(c.profileBId)?.company ?? "",
          c.createdAt.toISOString(),
        ],
      );
    } else if (kind === "meetings") {
      headers = [
        "Meeting ID",
        "Requester",
        "Recipient",
        "Start UTC",
        "End UTC",
        "Table",
        "Status",
        "Message",
      ];
      await this.meetings.expire(event.id);
      const [meetings, tables] = await Promise.all([
        store.all("meetings", { eventId: event.id }),
        store.all("tables", { eventId: event.id }),
      ]);
      const tableNames = new Map(tables.map((table) => [table.id, table.name]));
      rows = meetings
        .sort(
          (a, b) =>
            a.startsAt.getTime() - b.startsAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map((m) => [
          m.id,
          name(m.requesterId),
          name(m.recipientId),
          m.startsAt.toISOString(),
          m.endsAt.toISOString(),
          m.tableId ? tableNames.get(m.tableId) : "",
          m.status,
          m.message,
        ]);
    } else {
      headers = ["Sector", "Participants", "Matches", "Meetings"];
      rows = (await this.adminService.analytics(event.id)).sectors.map((s) => [
        s.sector,
        s.participants,
        s.matches,
        s.meetings,
      ]);
    }
    if (format === "csv")
      return {
        body: csv(headers, rows),
        contentType: "text/csv; charset=utf-8",
        kind,
        format,
      };
    if (format === "pdf")
      return {
        body: await generateNetworkingReportPdf(
          `${event.name} — ${kind}`,
          headers,
          rows,
        ),
        contentType: "application/pdf",
        kind,
        format,
      };
    // XLSX is generated into the body as Fastify sends it (streaming writer,
    // one row committed at a time): no workbook model, no whole-file buffer.
    return {
      body: downloadBody({
        filename: `networking-${kind}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        write: (out, signal) => writeAdminWorkbook(out, signal, kind, headers, rows),
      }),
      contentType: XLSX_CONTENT_TYPE,
      kind,
      format,
    };
  }
}

/** Rows between two waits on the zip and the client. */
const WORKBOOK_PAGE_ROWS = 500;

async function writeAdminWorkbook(
  out: Writable,
  signal: AbortSignal,
  kind: string,
  headers: string[],
  rows: unknown[][],
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
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: headers.length },
  };

  const cellStyles = new ColumnStyles(() => ({ alignment }));
  const pacer = new RowPacer(out, signal, sheet);
  for (let index = 0; index < rows.length; index++) {
    const row = sheet.addRow(rows[index]!.map((value) => value ?? ""));
    row.eachCell((cell, column) => {
      cell.style = cellStyles.for(column, cell.type);
    });
    row.commit();
    await pacer.row();
    if ((index + 1) % WORKBOOK_PAGE_ROWS === 0) await pacer.pageDone();
  }

  signal.throwIfAborted();
  sheet.commit();
  await workbook.commit();
}

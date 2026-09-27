import { networkingExportDatasets, type NetworkingExportKind } from "./networking.export-data";
import { csv, renderNetworkingTable } from "./networking.export-render";
import { BadRequestException, Injectable } from "@nestjs/common";
import { networkingStore, type NetworkingRow } from "@app/db";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingContext } from "./networking.service";
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
  async admin(event: NetworkingRow<"events">, kind: string, format: string) {
    if (
      !Object.hasOwn(networkingExportDatasets, kind) ||
      !["csv", "xlsx", "pdf"].includes(format)
    )
      throw new BadRequestException(
        "Choose participants, matches, meetings or sectors and csv, xlsx or pdf",
      );
    const store = networkingStore();
    const profiles = await store.all("profiles", { eventId: event.id });
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const name = (id: string) => {
      const p = byId.get(id);
      return p ? `${p.firstName} ${p.lastName}` : id;
    };
    const { headers, rows } = await networkingExportDatasets[kind as NetworkingExportKind]({ event, store, profiles, byId, name, meetingsService: this.meetings });
    return {
      ...await renderNetworkingTable(format, `${event.name} — ${kind}`, kind, headers, rows),
      kind,
      format,
    };
  }
}

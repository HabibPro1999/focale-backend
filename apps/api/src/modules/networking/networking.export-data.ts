import type { NetworkingRow, NetworkingStore } from "@app/db";
import { networkingAnalytics } from "./networking.analytics";
import { networkingEngagement } from "./networking.engagement";
import type { NetworkingMeetingsService } from "./networking.meetings.service";

export type ExportDataset = { headers: string[]; rows: unknown[][] };
type ExportContext = {
  event: NetworkingRow<"events">;
  store: NetworkingStore;
  profiles: NetworkingRow<"profiles">[];
  byId: Map<string, NetworkingRow<"profiles">>;
  name: (id: string) => string;
  meetingsService: NetworkingMeetingsService;
};

export const networkingExportDatasets = {
  participants: async ({ event, store, profiles, name }: ExportContext): Promise<ExportDataset> => {
    const headers = [
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
    const { engagement: counts } = networkingEngagement({ profiles, interests, connections, messages, meetings, audit });
    const rows = profiles.map((p) => [
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
    return { headers, rows };
  },
  matches: async ({ event, store, byId, name }: ExportContext): Promise<ExportDataset> => {
    const headers = [
      "Connection ID",
      "Participant A",
      "Company A",
      "Participant B",
      "Company B",
      "Created at",
    ];
    const rows = (await store.all("connections", { eventId: event.id })).map(
      (c) => [
        c.id,
        name(c.profileAId),
        byId.get(c.profileAId)?.company ?? "",
        name(c.profileBId),
        byId.get(c.profileBId)?.company ?? "",
        c.createdAt.toISOString(),
      ],
    );
    return { headers, rows };
  },
  meetings: async ({ event, store, name, meetingsService }: ExportContext): Promise<ExportDataset> => {
    const headers = [
      "Meeting ID",
      "Requester",
      "Recipient",
      "Start UTC",
      "End UTC",
      "Table",
      "Status",
      "Message",
    ];
    await meetingsService.expire(event.id);
    const [meetings, tables] = await Promise.all([
      store.all("meetings", { eventId: event.id }),
      store.all("tables", { eventId: event.id }),
    ]);
    const tableNames = new Map(tables.map((table) => [table.id, table.name]));
    const rows = meetings
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
    return { headers, rows };
  },
  sectors: async ({ event }: ExportContext): Promise<ExportDataset> => {
    const headers = ["Sector", "Participants", "Matches", "Meetings"];
    const rows = (await networkingAnalytics(event.id)).sectors.map((s) => [
      s.sector,
      s.participants,
      s.matches,
      s.meetings,
    ]);
    return { headers, rows };
  },
};
export type NetworkingExportKind = keyof typeof networkingExportDatasets;

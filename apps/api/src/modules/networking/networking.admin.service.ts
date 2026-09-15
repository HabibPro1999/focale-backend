import { NetworkingInventoryService } from "./networking.inventory.service";
import { networkingAnalytics } from "./networking.analytics";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  NetworkingConfigSchema,
  networkingProfileOverrides,
  networkingActivity,
  type NetworkingConfig,
  type NetworkingAnalytics,
} from "@app/contracts";
import {
  queueNetworkingActivation,
  networkingEmailMetrics,
  latestNetworkingPostEventReport,
  cancelNetworkingParticipantMeetings,
  getActiveEventAccessId,
  createNetworkingNotification,
  getNetworkingConfig,
  networkingStore,
  networkingTransaction,
  revokeNetworkingSessions,
  syncNetworkingEvent,
  type NetworkingRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { assertClientModuleEnabled } from "../clients/module-gates";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { networkingPublicProfile, networkingSlots, zonedInstant } from "./networking.policy";
const participationCopy = {
  en: {
    title: "Networking participation updated",
    ACTIVE: "Your networking participation is active.",
    PENDING: "Your networking participation is awaiting approval.",
    SUSPENDED: "Your networking participation is suspended.",
    EXCLUDED: "You have been excluded from networking.",
  },
  fr: {
    title: "Participation au networking mise à jour",
    ACTIVE: "Votre participation au networking est active.",
    PENDING: "Votre participation au networking est en attente de validation.",
    SUSPENDED: "Votre participation au networking est suspendue.",
    EXCLUDED: "Vous avez été exclu du networking.",
  },
  ar: {
    title: "تم تحديث المشاركة في التواصل المهني",
    ACTIVE: "مشاركتك في التواصل المهني مفعّلة.",
    PENDING: "مشاركتك في التواصل المهني بانتظار الموافقة.",
    SUSPENDED: "تم تعليق مشاركتك في التواصل المهني.",
    EXCLUDED: "تم استبعادك من التواصل المهني.",
  },
};
@Injectable()
export class NetworkingAdminService {
  constructor(
    private readonly networking: NetworkingService,
    private readonly meetings: NetworkingMeetingsService,
    readonly inventory: NetworkingInventoryService = new NetworkingInventoryService(),
  ) {}
  async config(
    eventId: string,
    input?: Partial<NetworkingConfig>,
    actorId?: string,
  ) {
    const current = await getNetworkingConfig(eventId);
    if (!input) return current;
    const parsed = NetworkingConfigSchema.safeParse({ ...current, ...input });
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const config = parsed.data;
    if (!config.languages.includes(config.defaultLanguage))
      throw new BadRequestException("Default language must be enabled");
    if (config.opensAt && config.closesAt && config.opensAt >= config.closesAt)
      throw new BadRequestException("Closing date must follow opening date");
    const event = await networkingStore().one("events", { id: eventId });
    if (!event) throw new NotFoundException("Event not found");
    if (config.openingHours.some((window) =>
      zonedInstant(window.date, window.start, config.timezone) < event.startDate ||
      zonedInstant(window.date, window.end, config.timezone) > event.endDate
    ))
      throw new BadRequestException("Meeting opening hours must be within the event dates");
    if (
      config.requiredAccessId &&
      !(await getActiveEventAccessId(config.requiredAccessId, eventId))
    )
      throw new BadRequestException(
        "Networking area access must be active and belong to this event",
      );
    if (config.enabled) {
      await assertClientModuleEnabled(event.clientId, "registrations");
      await assertClientModuleEnabled(event.clientId, "emails");
      if (config.meetingsEnabled && !config.openingHours.length)
        throw new BadRequestException(
          "Configure meeting opening hours before activating meetings",
        );
    }
    await networkingTransaction(eventId, async (store) => {
      const meetings = await store.all("meetings", { eventId });
      const valid = new Set(networkingSlots(config, event));
      if (
        meetings.some(
          (v) =>
            ["CONFIRMED", "PENDING_ALLOCATION"].includes(v.status) &&
            v.endsAt > new Date() &&
            (!valid.has(v.startsAt.toISOString()) ||
              v.endsAt.getTime() - v.startsAt.getTime() !==
                config.slotDurationMinutes * 60_000),
        )
      )
        throw new ConflictException(
          "Existing appointments conflict with the proposed opening hours or duration",
        );
      if (await store.one("configs", { eventId }))
        await store.update("configs", { eventId }, { config });
      else await store.insert("configs", { eventId, config });
      await store.insert("audit", {
        eventId,
        actorId: actorId!,
        action: "CONFIG_UPDATED",
        data: { fields: Object.keys(input) },
      });
    });
    if (
      config.enabled &&
      [
        "enabled",
        "approvalMode",
        "eligiblePaymentStatuses",
        "fieldMapping",
      ].some((key) => key in input)
    )
      await syncNetworkingEvent(eventId);
    return config;
  }
  async verifyBadge(eventId: string, token: string, accessId?: string) {
    const profileId = await this.networking.badgeProfileId(eventId, token);
    const store = networkingStore();
    const profile = await store.one("profiles", { id: profileId, eventId });
    const event = await store.one("events", { id: eventId });
    if (!profile || !event)
      throw new NotFoundException("Participant not found");
    const config = await getNetworkingConfig(eventId);
    const accessAllowed =
      config.enabled &&
      (await this.networking.areaAccess(
        { event, config, profile },
        accessId ?? config.requiredAccessId,
      ));
    return {
      accessAllowed,
      profile: networkingPublicProfile(profile),
      accessId: accessId ?? config.requiredAccessId ?? null,
    };
  }
  async profiles(
    eventId: string,
    query: {
      q?: string;
      sector?: string;
      status?: string;
      activity?: string;
      page: number;
      limit: number;
    },
  ) {
    const store = networkingStore();
    let rows = await store.all("profiles", { eventId });
    const connections = await store.all("connections", { eventId });
    const meetings = await store.all("meetings", { eventId });
    rows = rows.filter(
      (p) =>
        (!query.q ||
          `${p.firstName} ${p.lastName} ${p.company} ${p.jobTitle} ${p.email}`
            .toLowerCase()
            .includes(query.q.toLowerCase())) &&
        (!query.sector || p.sector === query.sector) &&
        (!query.status || p.status === query.status),
    );
    const enriched = rows.map((p) => ({
      ...p,
      matchCount: connections.filter(
        (c) => c.profileAId === p.id || c.profileBId === p.id,
      ).length,
      meetingCount: meetings.filter(
        (m) =>
          (m.requesterId === p.id || m.recipientId === p.id) &&
          !["CANCELLED", "DECLINED", "EXPIRED"].includes(m.status),
      ).length,
    }));
    const items = enriched.filter(
      (p) =>
        !query.activity ||
        query.activity === "ALL" ||
        (query.activity === "MATCHED"
          ? p.matchCount > 0
          : query.activity === "MEETINGS"
            ? p.meetingCount > 0
            : networkingActivity(p.lastActiveAt) === query.activity),
    );
    return {
      items: items.slice(
        (query.page - 1) * query.limit,
        query.page * query.limit,
      ),
      total: items.length,
    };
  }
  async updateProfile(
    eventId: string,
    id: string,
    input: Partial<NetworkingRow<"profiles">>,
    actorId: string,
  ) {
    return networkingTransaction(eventId, async (store, db) => {
      const profile = await store.one("profiles", { eventId, id });
      if (!profile) throw new NotFoundException("Participant not found");
      if (input.standTableId !== undefined) {
        await this.inventory.assertRepresentativeMove(store, eventId, profile, input.standTableId);
        if (profile.standTableId && profile.standTableId !== input.standTableId) {
          await store.update("tables", { eventId, id: profile.standTableId, ownerProfileId: id }, { ownerProfileId: null });
        }
      }
      const [row] = await store.update(
        "profiles",
        { eventId, id },
        { ...input, overrides: networkingProfileOverrides({ ...profile.overrides, ...input }) },
      );
      if (
        (input.status && input.status !== "ACTIVE") ||
        input.consent === false
      ) {
        await revokeNetworkingSessions(id, db);
        await cancelNetworkingParticipantMeetings(id, eventId, db);
      }
      await store.insert("audit", {
        eventId,
        actorId,
        action: "PROFILE_UPDATED",
        targetId: id,
        data: { fields: Object.keys(input), status: input.status },
      });
      if(input.status==="ACTIVE" && await this.networking.eligible(row,await getNetworkingConfig(eventId,db),store))await queueNetworkingActivation(id,eventId,db);
      else if (input.status && input.status !== profile.status)
        await createNetworkingNotification(
          {
            eventId,
            profileId: id,
            type: "APPROVAL",
            title: participationCopy[row.language].title,
            body: participationCopy[row.language][input.status],
            data: { status: input.status },
          },
          db,
        );
      return row;
    });
  }
  tables(eventId: string) { return this.inventory.tables(eventId); }
  saveTable(eventId: string, input: Parameters<NetworkingInventoryService["saveTable"]>[1], actorId: string, id?: string) {
    return this.inventory.saveTable(eventId, input, actorId, id);
  }
  removeTable(eventId: string, id: string, actorId: string) { return this.inventory.removeTable(eventId, id, actorId); }
  async listMeetings(
    eventId: string,
    query: {
      q?: string;
      date?: string;
      status?: string;
      tableId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    await this.meetings.expire(eventId);
    const config = await getNetworkingConfig(eventId);
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: config.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
    const search = normalize(query.q ?? "");
    const matchingProfiles = search
      ? new Set((await networkingStore().all("profiles", { eventId }))
          .filter(profile => normalize(`${profile.firstName} ${profile.lastName} ${profile.company}`).includes(search))
          .map(profile => profile.id))
      : null;
    const rows = (await networkingStore().all("meetings", { eventId }))
      .filter(
        (v) =>
          (!matchingProfiles || matchingProfiles.has(v.requesterId) || matchingProfiles.has(v.recipientId)) &&
          (!query.status || v.status === query.status) &&
          (!query.tableId || v.tableId === query.tableId) &&
          (!query.date || formatter.format(v.startsAt) === query.date),
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return {
      items: await Promise.all(
        (query.limit ? rows.slice(((query.page??1)-1)*query.limit,(query.page??1)*query.limit) : rows)
          .map((v) => this.meetings.hydrate(v, undefined, true)),
      ),
      total: rows.length,
    };
  }
  async updateMeeting(
    eventId: string,
    id: string,
    input: {
      action: "ASSIGN" | "CANCEL" | "COMPLETED" | "NO_SHOW";
      tableId?: string;
    },
    actorId: string,
  ) {
    return networkingTransaction(eventId, async (store, db) => {
      const row = await store.one("meetings", { eventId, id });
      if (!row) throw new NotFoundException("Meeting not found");
      const event = await store.one("events", { id: eventId });
      const config = await getNetworkingConfig(eventId, db);
      const profile = await store.one("profiles", {
        eventId,
        id: row.requesterId,
      });
      if (!event || !profile)
        throw new NotFoundException("Participant not found");
      let update: Partial<NetworkingRow<"meetings">> = {
        revision: row.revision + 1,
      };
      if (input.action === "ASSIGN") {
        if (!["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(row.status))
          throw new ConflictException("Only active meetings can be assigned");
        const allocation = await this.meetings.reserve(
          { event, config, profile } as NetworkingContext,
          row,
          row.startsAt,
          row.endsAt,
          store,
          input.tableId,
          row.status === "PENDING",
        );
        update = { ...update, ...allocation };
      } else {
        if (
          !["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(row.status)
        )
          throw new ConflictException("Meeting is no longer editable");
        if (
          input.action !== "CANCEL" &&
          (row.status !== "CONFIRMED" || row.startsAt > new Date())
        )
          throw new ConflictException(
            "Attendance can only be recorded once a confirmed meeting starts",
          );
        update.status = input.action === "CANCEL" ? "CANCELLED" : input.action;
        await store.remove("reservations", { eventId, meetingId: id });
      }
      const [saved] = await store.update("meetings", { eventId, id }, update);
      await store.insert("audit", {
        eventId,
        actorId,
        action: `MEETING_${input.action}`,
        targetId: id,
        data: input,
      });
      await this.meetings.notify(
        { event },
        saved,
        `MEETING_${input.action}`,
        [row.requesterId, row.recipientId],
        db,
      );
      return this.meetings.hydrate(saved, store, true);
    });
  }
  async reports(
    eventId: string,
    query: { status?: string; page?: number; limit?: number } = {},
  ) {
    const store = networkingStore();
    const rows = (await store.all("reports", { eventId })).filter(
      (v) => !query.status || v.status === query.status,
    );
    const items = await Promise.all(
      rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(async (r) => ({
          ...r,
          reporter: await store.one("profiles", { id: r.reporterId, eventId }),
          profile: await store.one("profiles", { id: r.profileId, eventId }),
          message: r.messageId
            ? await store.one("messages", { id: r.messageId, eventId })
            : null,
        })),
    );
    return {
      items: items.slice(
        ((query.page ?? 1) - 1) * (query.limit ?? 10000),
        (query.page ?? 1) * (query.limit ?? 10000),
      ),
      total: items.length,
    };
  }
  async moderate(
    eventId: string,
    id: string,
    input: {
      action: "DISMISS" | "RESOLVE" | "WARN" | "SUSPEND" | "EXCLUDE";
      note?: string;
    },
    actorId: string,
  ) {
    return networkingTransaction(eventId, async (store, db) => {
      const report = await store.one("reports", { eventId, id });
      if (!report) throw new NotFoundException("Report not found");
      if (input.action === "SUSPEND" || input.action === "EXCLUDE") {
        await store.update(
          "profiles",
          { eventId, id: report.profileId },
          {
            status: input.action === "SUSPEND" ? "SUSPENDED" : "EXCLUDED",
            visible: false,
          },
        );
        await revokeNetworkingSessions(report.profileId, db);
        await cancelNetworkingParticipantMeetings(
          report.profileId,
          eventId,
          db,
        );
      }
      if (input.action === "WARN")
        await createNetworkingNotification(
          {
            eventId,
            profileId: report.profileId,
            type: "MODERATION_WARNING",
            title: "Organizer notice",
            body:
              input.note ??
              "Please review the event networking code of conduct.",
          },
          db,
        );
      const [saved] = await store.update(
        "reports",
        { eventId, id },
        {
          status: input.action === "DISMISS" ? "DISMISSED" : "RESOLVED",
          note: input.note ?? null,
          resolvedBy: actorId,
          resolvedAt: new Date(),
        },
      );
      await store.insert("audit", {
        eventId,
        actorId,
        action: `REPORT_${input.action}`,
        targetId: id,
        data: { note: input.note },
      });
      return saved;
    });
  }
  async postEventReport(eventId:string) {
    const report=await latestNetworkingPostEventReport(eventId);
    if(!report)return {available:false};
    if(!report.storageKey.startsWith(`networking/reports/${eventId}/`) || report.storageKey.includes(".."))throw new BadRequestException("Invalid report storage location");
    return {available:true,url:await getStorageProvider().getSignedUrl(report.storageKey,900),generatedAt:report.generatedAt,summary:report.summary};
  }
  async analytics(eventId: string): Promise<NetworkingAnalytics> {
    return networkingAnalytics(eventId);
  }
}

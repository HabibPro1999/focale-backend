import { networkingCalendarDay } from "./networking.calendar";
import { NetworkingCalendarQuerySchema, type NetworkingCalendarQuery } from "@app/contracts";
import { randomUUID } from "node:crypto";
import { NetworkingInventoryService } from "./networking.inventory.service";
import { networkingAnalytics } from "./networking.analytics";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  NetworkingConfigSchema,
  NETWORKING_CONFIG_UNCONFIGURED_REVISION,
  type NetworkingConfigWithRevision,
  networkingProfileOverrides,
  networkingActivity,
  type NetworkingConfig,
  type NetworkingAnalytics,
} from "@app/contracts";
import {
  queueNetworkingActivation,
  latestNetworkingPostEventReport,
  cancelNetworkingParticipantMeetings,
  getActiveEventAccessId,
  createNetworkingNotification,
  getNetworkingConfig,
  networkingFormField,
  networkingMeetingIs,
  networkingProfileListed,
  networkingRetentionEnded,
  networkingStore,
  networkingTransaction,
  revokeNetworkingSessions,
  requestNetworkingEventSync,
  transitionNetworkingMeetings,
  type NetworkingRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { createLogger } from "@app/shared";
import { deleteNetworkingPhoto } from "./networking.uploads.service";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import {
  NetworkingService,
  type NetworkingContext,
} from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { networkingPublicProfile, networkingSlots, zonedInstant } from "./networking.policy";
const log = createLogger({ name: "networking:admin" });
const CONSENT_FIELD_TYPES = ["checkbox", "radio", "dropdown", "select"];
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
    input?: Partial<NetworkingConfig> & { expectedRevision?: string },
    actorId?: string,
  ): Promise<NetworkingConfigWithRevision> {
    if (!input) {
      const row = await networkingStore().one("configs", { eventId });
      return {
        ...NetworkingConfigSchema.parse(row?.config ?? {}),
        revision: row?.updatedAt.toISOString() ?? NETWORKING_CONFIG_UNCONFIGURED_REVISION,
      };
    }
    const { expectedRevision, ...changes } = input;
    const config = await networkingTransaction(eventId, async (store, db) => {
      const current = await store.one("configs", { eventId });
      const revision = current?.updatedAt.toISOString() ?? NETWORKING_CONFIG_UNCONFIGURED_REVISION;
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new ConflictException({
          code: "NETWORKING_CONFIG_STALE",
          message: "Networking configuration has changed. Reload before saving.",
        });
      const invalid = (message: string, details?: unknown) => new BadRequestException({
        code: "NETWORKING_VALIDATION", message, ...(details ? { details } : {}),
      });
      const parsed = NetworkingConfigSchema.safeParse({ ...current?.config, ...changes });
      if (!parsed.success) throw invalid("Invalid networking configuration", parsed.error.flatten());
      const config = parsed.data;
      if (!config.languages.includes(config.defaultLanguage))
        throw invalid("Default language must be enabled");
      if ([config.opensAt, config.closesAt, ...config.blackoutSlots].some(
        (value) => value != null && !Number.isFinite(Date.parse(value)),
      )) throw invalid("Invalid networking date");
      if (config.opensAt && config.closesAt && Date.parse(config.opensAt) >= Date.parse(config.closesAt))
        throw invalid("Closing date must follow opening date");
      const event = await store.one("events", { id: eventId });
      if (!event) throw new NotFoundException("Event not found");
      // Re-enabling after retention would let registration sync copy personal data back
      // in; once the purge has started, the event can never be enabled again.
      if (
        config.enabled &&
        (current?.purgeStartedAt ||
          (current?.config?.enabled !== true && networkingRetentionEnded(event.endDate, config.retentionDays)))
      )
        throw new ConflictException({
          code: "NETWORKING_RETENTION_ENDED",
          message: "The networking retention period of this event has ended; it cannot be enabled again",
        });
      if (config.openingHours.some((window) => {
        let start: number, end: number;
        try {
          start = zonedInstant(window.date, window.start, config.timezone).getTime();
          end = zonedInstant(window.date, window.end, config.timezone).getTime();
        } catch {
          throw invalid("Invalid meeting opening hours");
        }
        return !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
          start < event.startDate.getTime() || end > event.endDate.getTime();
      }))
        throw invalid("Meeting opening hours must be within the event dates");
      if (
        config.requiredAccessId &&
        !(await getActiveEventAccessId(config.requiredAccessId, eventId, db))
      )
        throw invalid("Networking area access must be active and belong to this event");
      const consentFieldId = config.fieldMapping.consent;
      if ("fieldMapping" in changes && consentFieldId) {
        const field = (await store.all("forms", { eventId }))
          .map((form) => networkingFormField(form.schema, consentFieldId))
          .find(Boolean);
        if (!field || !CONSENT_FIELD_TYPES.includes(String(field.type)))
          throw invalid("Consent mapping must point to a checkbox, radio or select field of the registration form");
      }
      if (config.enabled) {
        await assertClientModuleEnabled(event.clientId, "registrations", db);
        await assertClientModuleEnabled(event.clientId, "emails", db);
        if (config.meetingsEnabled && !config.openingHours.length)
          throw invalid("Configure meeting opening hours before activating meetings");
      }
      const meetings = await store.all("meetings", { eventId });
      const valid = new Set(networkingSlots(config, event));
      if (
        meetings.some(
          (v) =>
            networkingMeetingIs(v.status, "accepted") &&
            v.endsAt > new Date() &&
            (!valid.has(v.startsAt.toISOString()) ||
              v.endsAt.getTime() - v.startsAt.getTime() !==
                config.slotDurationMinutes * 60_000),
        )
      )
        throw new ConflictException(
          "Existing appointments conflict with the proposed opening hours or duration",
        );
      // Millisecond storage precision must not let consecutive writes share a revision.
      const updatedAt = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() ?? -1) + 1));
      if (current)
        await store.update("configs", { eventId }, { config, updatedAt });
      else await store.insert("configs", { eventId, config, updatedAt });
      await store.insert("audit", {
        eventId,
        actorId: actorId!,
        action: "CONFIG_UPDATED",
        data: { fields: Object.keys(changes) },
      });
      return { ...config, revision: updatedAt.toISOString() };
    });
    if (
      config.enabled &&
      [
        "enabled",
        "approvalMode",
        "eligiblePaymentStatuses",
        "fieldMapping",
      ].some((key) => key in changes)
    )
      try {
        // The worker re-projects every registration in chunks (plan 4.8).
        await requestNetworkingEventSync(eventId);
      } catch (error) {
        // The config is committed; the organizer can request the sync again, so the saved revision is still returned.
        log.error({ err: error, eventId }, "Networking registration sync request failed after a config update");
      }
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
    // Erased profiles are tombstones with nothing to show (4.6 policy).
    let rows = (await store.all("profiles", { eventId })).filter(networkingProfileListed);
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
          !networkingMeetingIs(m.status, "released"),
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
    const { row, previousPhotoUrl } = await networkingTransaction(eventId, async (store, db) => {
      const profile = await store.one("profiles", { eventId, id });
      if (!profile) throw new NotFoundException("Participant not found");
      // Withdrawal is final: its scrubbed content (and later the erased tombstone) is never rewritten.
      if (profile.withdrawnAt)
        throw new ConflictException({
          code: "NETWORKING_PROFILE_WITHDRAWN",
          message: "This participant has withdrawn from networking; the profile cannot be edited",
        });
      const previousPhotoUrl = profile.photoUrl;
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
      return { row, previousPhotoUrl };
    });
    if ((input.status && input.status !== "ACTIVE") || input.consent === false)
      networkingIdentityCache.forgetProfile(id);
    if (row.photoUrl !== previousPhotoUrl) await deleteNetworkingPhoto(previousPhotoUrl, eventId, id);
    return row;
  }
  tables(eventId: string) { return this.inventory.tables(eventId); }
  saveTable(eventId: string, input: Parameters<NetworkingInventoryService["saveTable"]>[1], actorId: string, id?: string) {
    return this.inventory.saveTable(eventId, input, actorId, id);
  }
  removeTable(eventId: string, id: string, actorId: string) { return this.inventory.removeTable(eventId, id, actorId); }
  async calendar(eventId: string, input: NetworkingCalendarQuery) {
    const parsed = NetworkingCalendarQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Invalid calendar query" });
    const query = parsed.data;
    const { timezone } = await getNetworkingConfig(eventId);
    const { start, end } = networkingCalendarDay(query.date, timezone);
    await this.meetings.expire(eventId);
    const rows = await networkingStore().calendarMeetings(eventId, start, end, query);
    if (rows.length > 5000) throw new BadRequestException({
      code: "NETWORKING_VALIDATION", message: "Calendar exceeds 5000 meetings. Use the paginated list.",
    });
    return { date: query.date, timezone, items: await this.meetings.hydrateCalendar(eventId, rows) };
  }
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
    // Assigning claims the meeting's own slot; the other actions only release resources.
    const plan = async () => {
      if (input.action !== "ASSIGN") return [];
      const row = await networkingStore().one("meetings", { eventId, id });
      return row ? [{ startsAt: row.startsAt, endsAt: row.endsAt }] : [];
    };
    return this.meetings.allocation(eventId, plan, async (store, db) => {
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
      let saved: NetworkingRow<"meetings"> | undefined;
      if (input.action === "ASSIGN") {
        if (!networkingMeetingIs(row.status, "open"))
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
        [saved] = await store.update("meetings", { eventId, id }, { ...allocation, revision: row.revision + 1 });
      } else {
        if (!networkingMeetingIs(row.status, "open"))
          throw new ConflictException("Meeting is no longer editable");
        if (
          input.action !== "CANCEL" &&
          (row.status !== "CONFIRMED" || row.startsAt > new Date())
        )
          throw new ConflictException(
            "Attendance can only be recorded once a confirmed meeting starts",
          );
        // CANCEL releases every reservation; COMPLETED and NO_SHOW keep them (the slot was used).
        [saved] = await transitionNetworkingMeetings(db, input.action, eventId, [id],
          input.action === "CANCEL" ? { proposedStartsAt: null, proposalBy: null } : {});
      }
      if (!saved) throw new ConflictException("Meeting is no longer editable");
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
        { reason: "ORGANIZER" },
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
    let revokedProfileId: string | undefined;
    const resolved = await networkingTransaction(eventId, async (store, db) => {
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
        revokedProfileId = report.profileId;
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
    if (revokedProfileId) networkingIdentityCache.forgetProfile(revokedProfileId);
    return resolved;
  }
  async regeneratePostEventReport(eventId: string, actorId: string) {
    return networkingTransaction(eventId, async (store) => {
      const event = await store.one("events", { id: eventId });
      if (!event) throw new NotFoundException("Event not found");
      if (!NetworkingConfigSchema.parse((await store.one("configs", { eventId }))?.config ?? {}).enabled)
        throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Networking is not enabled for this event" });
      const now = new Date();
      if (event.endDate > now) throw new ConflictException({
        code: "NETWORKING_ACTION_NOT_ALLOWED", message: "Report can be generated after the event ends",
      });
      const pending = (await store.all("deliveries", { eventId, type: "POST_EVENT_REPORT" }))
        .find((row) => row.status === "PENDING" || row.status === "PROCESSING" || (row.status === "FAILED" && row.attempts < 5));
      if (pending) return { deliveryId: pending.id, availableAt: pending.availableAt, version: pending.id };
      const id = randomUUID();
      await store.insert("deliveries", {
        id, eventId, type: "POST_EVENT_REPORT", payload: { version: id, manual: true },
        status: "PENDING", availableAt: now, dedupeKey: `post-event-report:${eventId}:${id}`,
      });
      await store.insert("audit", {
        eventId, actorId, action: "POST_EVENT_REPORT_REGENERATE", targetId: id, data: { version: id },
      });
      return { deliveryId: id, availableAt: now, version: id };
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

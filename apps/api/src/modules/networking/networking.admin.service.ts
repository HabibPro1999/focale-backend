import { validateNetworkingConfig } from "./networking.config-validation";
import { ErrorCodes } from "@app/contracts";
import { revokeParticipantAccess } from "./networking.revocation";
import { networkingCalendarDay } from "./networking.calendar";
import { NetworkingCalendarQuerySchema, type NetworkingCalendarQuery } from "@app/contracts";
import { randomUUID } from "node:crypto";
import { NetworkingInventoryService } from "./networking.inventory.service";
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
  type NetworkingConfig,
} from "@app/contracts";
import {
  withLockingTxn,
  getDb,
  queueNetworkingActivation,
  latestNetworkingPostEventReport,
  createNetworkingNotification,
  getNetworkingConfig,
  listNetworkingAdminMeetings,
  listNetworkingAdminProfiles,
  listNetworkingAdminReports,
  networkingMeetingIs,
  networkingStore,
  networkingTransaction,
  requestNetworkingEventSync,
  transitionNetworkingMeetings,
  type NetworkingRow,
} from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { createLogger } from "@app/shared";
import { deleteNetworkingPhoto } from "./networking.uploads.service";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import {
  NetworkingService,
} from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { networkingPublicProfile } from "./networking.policy";
const log = createLogger({ name: "networking:admin" });
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
    private readonly inventory: NetworkingInventoryService,
  ) {}
  async getConfig(eventId: string): Promise<NetworkingConfigWithRevision> {
    const row = await networkingStore(getDb()).one("configs", { eventId });
    return {
      ...NetworkingConfigSchema.parse(row?.config ?? {}),
      revision: row?.updatedAt.toISOString() ?? NETWORKING_CONFIG_UNCONFIGURED_REVISION,
    };
  }
  async updateConfig(
    eventId: string,
    input: Partial<NetworkingConfig> & { expectedRevision?: string },
    actorId: string,
  ): Promise<NetworkingConfigWithRevision> {
    const { expectedRevision, ...changes } = input;
    const config = await networkingTransaction(eventId, async (store, db) => {
      const current = await store.one("configs", { eventId });
      const revision = current?.updatedAt.toISOString() ?? NETWORKING_CONFIG_UNCONFIGURED_REVISION;
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new ConflictException({
          code: ErrorCodes.NETWORKING_CONFIG_STALE,
          message: "Networking configuration has changed. Reload before saving.",
        });
      const config = await validateNetworkingConfig({ eventId, current, changes, store, db });
      // Millisecond storage precision must not let consecutive writes share a revision.
      const updatedAt = new Date(Math.max(Date.now(), (current?.updatedAt.getTime() ?? -1) + 1));
      if (current)
        await store.update("configs", { eventId }, { config, updatedAt });
      else await store.insert("configs", { eventId, config, updatedAt });
      await store.insert("audit", {
        eventId,
        actorId,
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
        await withLockingTxn((tx) => requestNetworkingEventSync(eventId, tx));
      } catch (error) {
        // The config is committed; the organizer can request the sync again, so the saved revision is still returned.
        log.error({ err: error, eventId }, "Networking registration sync request failed after a config update");
      }
    return config;
  }
  async verifyBadge(eventId: string, token: string, accessId?: string) {
    const profileId = await this.networking.badgeProfileId(eventId, token);
    const store = networkingStore(getDb());
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
  /** One SQL page of listed participants with the total (4.9). */
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
    return listNetworkingAdminProfiles(eventId, query);
  }
  async updateProfile(
    eventId: string,
    id: string,
    input: Partial<NetworkingRow<"profiles">>,
    actorId: string,
  ) {
    const { row, previousPhotoUrl, revoked } = await networkingTransaction(eventId, async (store, db) => {
      const profile = await store.one("profiles", { eventId, id });
      if (!profile) throw new NotFoundException("Participant not found");
      // Withdrawal is final: its scrubbed content (and later the erased tombstone) is never rewritten.
      if (profile.withdrawnAt)
        throw new ConflictException({
          code: ErrorCodes.NETWORKING_PROFILE_WITHDRAWN,
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
      const revoked = !!((input.status && input.status !== "ACTIVE") || input.consent === false);
      if (revoked) await revokeParticipantAccess(id, eventId, db);
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
      return { row, previousPhotoUrl, revoked };
    });
    if (revoked)
      networkingIdentityCache.forgetProfile(id);
    if (row.photoUrl !== previousPhotoUrl) await deleteNetworkingPhoto(previousPhotoUrl, eventId, id);
    return row;
  }
  async calendar(eventId: string, input: NetworkingCalendarQuery) {
    const parsed = NetworkingCalendarQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message: "Invalid calendar query" });
    const query = parsed.data;
    const { timezone } = await getNetworkingConfig(eventId);
    const { start, end } = networkingCalendarDay(query.date, timezone);
    await this.meetings.expire(eventId);
    const rows = await networkingStore(getDb()).calendarMeetings(eventId, start, end, query);
    if (rows.length > 5000) throw new BadRequestException({
      code: ErrorCodes.NETWORKING_VALIDATION, message: "Calendar exceeds 5000 meetings. Use the paginated list.",
    });
    return { date: query.date, timezone, items: await this.meetings.hydrateCalendar(eventId, rows) };
  }
  /** One SQL page of meetings with the total, hydrated in bulk (4.9). */
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
    // The date is the meeting's start day in the event timezone (as the calendar).
    const day = query.date ? networkingCalendarDay(query.date, (await getNetworkingConfig(eventId)).timezone) : undefined;
    const { rows, total } = await listNetworkingAdminMeetings(eventId, {
      q: query.q,
      status: query.status,
      tableId: query.tableId,
      startsFrom: day?.start,
      startsBefore: day?.end,
      page: query.page,
      limit: query.limit,
    });
    return { items: await this.meetings.hydrateAdmin(eventId, rows), total };
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
      const row = await networkingStore(getDb()).one("meetings", { eventId, id });
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
          { event, config },
          row,
          row.startsAt,
          row.endsAt,
          store,
          { forcedTableId: input.tableId, hold: row.status === "PENDING" },
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
      const [item] = await this.meetings.hydrateAdmin(eventId, [saved], store);
      return item!;
    });
  }
  /** One SQL page of reports, newest first, with the total and each report's people and message (4.9). */
  async reports(
    eventId: string,
    query: { status?: string; page?: number; limit?: number } = {},
  ) {
    return listNetworkingAdminReports(eventId, query);
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
    const { resolved, revokedProfileId } = await networkingTransaction(eventId, async (store, db) => {
      let revokedProfileId: string | undefined;
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
        await revokeParticipantAccess(report.profileId, eventId, db);
        revokedProfileId = report.profileId;
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
      return { resolved: saved, revokedProfileId };
    });
    if (revokedProfileId) networkingIdentityCache.forgetProfile(revokedProfileId);
    return resolved;
  }
  async regeneratePostEventReport(eventId: string, actorId: string) {
    return networkingTransaction(eventId, async (store) => {
      const event = await store.one("events", { id: eventId });
      if (!event) throw new NotFoundException("Event not found");
      if (!NetworkingConfigSchema.parse((await store.one("configs", { eventId }))?.config ?? {}).enabled)
        throw new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message: "Networking is not enabled for this event" });
      const now = new Date();
      if (event.endDate > now) throw new ConflictException({
        code: ErrorCodes.NETWORKING_ACTION_NOT_ALLOWED, message: "Report can be generated after the event ends",
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
}

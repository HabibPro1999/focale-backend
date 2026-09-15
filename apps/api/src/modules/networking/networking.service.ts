import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes, randomInt } from "node:crypto";
import {
  listNetworkingDiscovery,
  touchNetworkingProfileActivity,
  cancelNetworkingParticipantMeetings,
  getActiveEventAccessId,
  createNetworkingNotification,
  enqueueNetworkingDelivery,
  getNetworkingConfig,
  networkingStore,
  networkingTransaction,
  revokeNetworkingSessions,
  syncNetworkingRegistration,
  type NetworkingRow,
  type NetworkingStore,
} from "@app/db";
import { NetworkingConfigSchema, networkingProfileComplete, networkingProfileOverrides, type NetworkingConfig, type NetworkingPersonalAnalytics } from "@app/contracts";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { networkingHash, sealNetworkingCode, readNetworkingBadge } from "./networking.security";
import {
  networkingSearchMatches,
  networkingPair,
  networkingPublicProfile,
} from "./networking.policy";
export type NetworkingContext = {
  event: NetworkingRow<"events">;
  config: NetworkingConfig;
  profile: NetworkingRow<"profiles">;
  session: NetworkingRow<"sessions">;
};
export type NetworkingDiscoveryQuery = {
  q?: string;
  sector?: string;
  sectors?: string[];
  company?: string;
  excludeInteracted?: boolean;
  city?: string;
  country?: string;
  sort?: string;
  page?: number;
  limit?: number;
  status?: string;
};
@Injectable()
export class NetworkingService {
  async badgeProfileId(eventId: string, token: string, store = networkingStore()) {
    // Printed registration badges contain a UUID; the PWA also supports its signed, expiring badge.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      const profile = await store.one("profiles", { eventId, registrationId: token });
      if (!profile) throw new NotFoundException("Participant not found");
      return profile.id;
    }
    return readNetworkingBadge(token, eventId);
  }
  async publicContext(slug: string, store = networkingStore()) {
    const event = await store.one("events", { slug });
    if (!event) throw new NotFoundException("Event not found");
    await assertClientModuleEnabled(event.clientId, "networking");
    await assertClientModuleEnabled(event.clientId, "registrations");
    await assertClientModuleEnabled(event.clientId, "emails");
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: event.id }))?.config ?? {},
    );
    if (!config.enabled || event.status === "ARCHIVED")
      throw new ForbiddenException(
        "Networking is not available for this event",
      );
    if (config.opensAt && Date.parse(config.opensAt) > Date.now())
      throw new ForbiddenException("Networking is not open yet");
    if (config.closesAt && Date.parse(config.closesAt) < Date.now())
      throw new ForbiddenException("Networking has closed");
    if (
      Date.now() >
      event.endDate.getTime() + config.retentionDays * 86_400_000
    )
      throw new ForbiddenException("Networking retention period has ended");
    return { event, config };
  }
  async publicConfig(slug: string) {
    const { event, config } = await this.publicContext(slug);
    const {
      eligiblePaymentStatuses,
      retentionDays,
      emailTemplates,
      ...publicConfig
    } = config;
    const base = process.env.PUBLIC_NETWORKING_URL;
    let networkingUrl: string | undefined;
    try {
      if (base) {
        const url = new URL(base);
        if (["http:", "https:"].includes(url.protocol))
          networkingUrl = `${url.origin}${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(event.slug)}`;
      }
    } catch {}
    return {
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        startsAt: event.startDate,
        endsAt: event.endDate,
        location: event.location,
        bannerUrl: event.bannerUrl,
      },
      config: publicConfig,
      pushPublicKey: process.env.NETWORKING_VAPID_PUBLIC_KEY ?? null,
      networkingUrl,
    };
  }
  async areaAccess(
    ctx: Pick<NetworkingContext, "event" | "config" | "profile">,
    accessId = ctx.config.requiredAccessId,
  ) {
    if (!(await this.eligible(ctx.profile, ctx.config))) return false;
    const booked = (
      await networkingStore().all("meetings", {
        eventId: ctx.event.id,
        status: "CONFIRMED",
      })
    ).some((meeting) =>
      [meeting.requesterId, meeting.recipientId].includes(ctx.profile.id),
    );
    if (!booked) return false;
    if (!accessId) return true;
    if (!(await getActiveEventAccessId(accessId, ctx.event.id))) return false;
    const registration = await networkingStore().one("registrations", {
      id: ctx.profile.registrationId,
      eventId: ctx.event.id,
    });
    return !!registration?.accessTypeIds?.includes(accessId);
  }
  async eligible(
    profile: NetworkingRow<"profiles">,
    config: NetworkingConfig,
    store = networkingStore(),
  ) {
    if (profile.status !== "ACTIVE" || !profile.consent || profile.withdrawnAt)
      return false;
    const registration = await store.one("registrations", {
      id: profile.registrationId,
      eventId: profile.eventId,
    });
    return (
      !!registration &&
      (
        registration as typeof registration & {
          networkingOptIn?: boolean | null;
        }
      ).networkingOptIn !== false &&
      config.eligiblePaymentStatuses.includes(registration.paymentStatus)
    );
  }
  async participant(
    slug: string,
    authorization?: string,
    options: { allowPendingSecondFactor?: boolean } = {},
  ): Promise<NetworkingContext> {
    const { event, config } = await this.publicContext(slug);
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
    if (!token) throw new UnauthorizedException("Participant session required");
    const store = networkingStore();
    const session = await store.one("sessions", {
      eventId: event.id,
      tokenHash: networkingHash(token),
      revokedAt: null,
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException("Participant session expired");
    const profile = await store.one("profiles", {
      id: session.profileId,
      eventId: event.id,
    });
    if (!profile || !(await this.eligible(profile, config)))
      throw new ForbiddenException(
        "Networking participation is not approved or eligible",
      );
    const factor = await store.one("secondFactors", { profileId: profile.id });
    if (
      (config.requireSecondFactor || factor?.enabledAt) &&
      !session.secondFactorVerifiedAt &&
      !options.allowPendingSecondFactor
    ) {
      throw new ForbiddenException({
        code: "NETWORKING_MFA_REQUIRED",
        message: "Authenticator verification is required",
      });
    }
    if (
      !profile.lastActiveAt ||
      Date.now() - profile.lastActiveAt.getTime() > 60_000
    )
      await touchNetworkingProfileActivity(event.id, profile.id);
    return { event, config, profile, session };
  }
  /** Revalidate capabilities inside the event transaction, after concurrent admin/session changes. */
  async currentParticipant(
    ctx: NetworkingContext,
    store: NetworkingStore,
  ): Promise<NetworkingContext> {
    const event = await store.one("events", { id: ctx.event.id });
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: ctx.event.id }))?.config ?? {},
    );
    if (
      !event ||
      event.status === "ARCHIVED" ||
      !config.enabled ||
      (config.opensAt && Date.parse(config.opensAt) > Date.now()) ||
      (config.closesAt && Date.parse(config.closesAt) <= Date.now()) ||
      event.endDate.getTime() + config.retentionDays * 86400000 < Date.now()
    )
      throw new ForbiddenException(
        "Networking is not available for this event",
      );
    await assertClientModuleEnabled(event.clientId, "networking");
    const session = await store.one("sessions", {
      id: ctx.session.id,
      eventId: event.id,
      profileId: ctx.profile.id,
      revokedAt: null,
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException("Participant session expired");
    const profile = await store.one("profiles", {
      id: ctx.profile.id,
      eventId: event.id,
    });
    if (!profile || !(await this.eligible(profile, config, store)))
      throw new ForbiddenException(
        "Networking participation is no longer eligible",
      );
    const factor = await store.one("secondFactors", { profileId: profile.id });
    if (
      (config.requireSecondFactor || factor?.enabledAt) &&
      !session.secondFactorVerifiedAt
    )
      throw new ForbiddenException({
        code: "NETWORKING_MFA_REQUIRED",
        message: "Authenticator verification is required",
      });
    return { event, config, profile, session };
  }
  async requestCode(slug: string, email: string) {
    email = email.trim().toLowerCase();
    const { event, config } = await this.publicContext(slug);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = networkingHash(`otp:${event.id}:${email}:${code}`);
    return networkingTransaction(event.id, async (store, db) => {
      const { config } = await this.publicContext(slug, store);
      const recent = (
        await store.all("challenges", { eventId: event.id, email })
      ).filter((v) => Date.now() - v.createdAt.getTime() < 15 * 60_000);
      // Same generic response for throttled, unapproved and unknown email addresses.
      const challengeId = crypto.randomUUID();
      if (recent.length >= 5) return { challengeId };
      await store.update(
        "challenges",
        { eventId: event.id, email, consumedAt: null },
        { consumedAt: new Date() },
      );
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await store.insert("challenges", {
        id: challengeId,
        eventId: event.id,
        email,
        codeHash,
        expiresAt,
      });
      const profiles = await store.all("profiles", {
        eventId: event.id,
        email,
      });
      profiles.sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
      let profile: NetworkingRow<"profiles"> | undefined;
      for (const candidate of profiles) {
        if (await this.eligible(candidate, config, store)) {
          profile = candidate;
          break;
        }
      }
      if (profile)
        await enqueueNetworkingDelivery(
          {
            eventId: event.id,
            profileId: profile.id,
            email,
            type: "OTP",
            payload: {
              encryptedCode: sealNetworkingCode(code),
              challengeId,
              expiresAt: expiresAt.toISOString(),
              eventName: event.name,
              slug,
            },
            dedupeKey: `otp:${challengeId}`,
          },
          db,
        );
      return { challengeId };
    });
  }
  async verifyCode(slug: string, challengeId: string, code: string) {
    const { event, config } = await this.publicContext(slug);
    const result = await networkingTransaction(event.id, async (store) => {
      const { config } = await this.publicContext(slug, store);
      const challenge = await store.one("challenges", {
        id: challengeId,
        eventId: event.id,
      });
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now() ||
        challenge.attempts >= 5
      )
        return null;
      const valid =
        challenge.codeHash ===
        networkingHash(`otp:${event.id}:${challenge.email}:${code}`);
      await store.update(
        "challenges",
        { id: challenge.id, eventId: event.id },
        {
          attempts: challenge.attempts + 1,
          ...(valid ? { consumedAt: new Date() } : {}),
        },
      );
      if (!valid) return null;
      const profiles = await store.all("profiles", {
        eventId: event.id,
        email: challenge.email,
      });
      profiles.sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
      for (const profile of profiles) {
        if (!(await this.eligible(profile, config, store))) continue;
        const token = randomBytes(48).toString("base64url");
        const expiresAt = new Date(Date.now() + 30 * 86_400_000);
        await store.insert("sessions", {
          eventId: event.id,
          profileId: profile.id,
          tokenHash: networkingHash(token),
          expiresAt,
        });
        const factor = await store.one("secondFactors", {
          profileId: profile.id,
        });
        return {
          token,
          expiresAt,
          profile,
          requiresSecondFactor:
            config.requireSecondFactor || !!factor?.enabledAt,
          mfaEnrollmentRequired:
            config.requireSecondFactor && !factor?.enabledAt,
        };
      }
      return null;
    });
    if (!result)
      throw new UnauthorizedException("Invalid or expired verification code");
    return result;
  }
  async target(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
    visible = false,
  ) {
    if (id === ctx.profile.id)
      throw new BadRequestException("Choose another participant");
    const profile = await store.one("profiles", { id, eventId: ctx.event.id });
    if (
      !profile ||
      profile.email.trim().toLowerCase() ===
        ctx.profile.email.trim().toLowerCase() ||
      !(await this.eligible(profile, ctx.config, store)) ||
      (visible && (!profile.visible || !networkingProfileComplete(profile)))
    )
      throw new NotFoundException("Participant not available");
    const current = await store.one("profiles", {
      id: ctx.profile.id,
      eventId: ctx.event.id,
    });
    if (!current || !(await this.eligible(current, ctx.config, store)))
      throw new ForbiddenException(
        "Networking participation is no longer eligible",
      );
    if (
      ((!profile.visible || !networkingProfileComplete(profile)) && !visible) ||
      (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
    ) {
      const [profileAId, profileBId] = networkingPair(ctx.profile.id, id);
      if (
        !(await store.one("connections", {
          eventId: ctx.event.id,
          profileAId,
          profileBId,
        }))
      )
        throw new NotFoundException("Participant not available");
    }
    const blocked =
      (await store.one("blocks", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
        targetId: id,
      })) ||
      (await store.one("blocks", {
        eventId: ctx.event.id,
        profileId: id,
        targetId: ctx.profile.id,
      }));
    if (blocked) throw new NotFoundException("Participant not available");
    return profile;
  }
  async discover(ctx: NetworkingContext, query: NetworkingDiscoveryQuery = {}) {
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
      throw new ForbiddenException("Discovery is disabled");
    if (
      (query.q ||
        query.sector ||
        query.sectors?.length ||
        query.company ||
        query.city ||
        query.country) &&
      !ctx.config.searchEnabled
    )
      throw new ForbiddenException("Search is disabled");
    const result = await listNetworkingDiscovery(
      ctx.event.id,
      ctx.profile.id,
      ctx.config.eligiblePaymentStatuses,
      query,
    );
    return {
      items: result.items.map(networkingPublicProfile),
      total: result.total,
    };
  }

  async representatives(ctx: NetworkingContext, profileId: string, page = 1) {
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled) throw new ForbiddenException("Discovery is disabled");
    const profile = await this.target(ctx, profileId);
    const stand = profile.standTableId ? await networkingStore().one("tables", { eventId: ctx.event.id, id: profile.standTableId, kind: "STAND" }) : null;
    if (!stand) return { items: [], total: 0, exhibitor: null };
    const space = stand.spaceId ? await networkingStore().one("spaces", { eventId: ctx.event.id, id: stand.spaceId }) : null;
    if (!stand.active || space?.active === false) return { items: [], total: 0, exhibitor: null };
    const result = await listNetworkingDiscovery(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses,
      { standTableId: stand.id, page, limit: 30 });
    return { items: result.items.map(networkingPublicProfile), total: result.total,
      exhibitor: { id: stand.id, name: stand.name, spaceName: space?.name ?? null } };
  }

  async personalAnalytics(ctx: NetworkingContext): Promise<NetworkingPersonalAnalytics> {
    const store = networkingStore();
    ctx = await this.currentParticipant(ctx, store);
    const email = ctx.profile.email.trim().toLowerCase();
    const events = await store.all("events", { clientId: ctx.event.clientId });
    const result: NetworkingPersonalAnalytics["events"] = [];
    for (const event of events) {
      const profiles = await store.all("profiles", { eventId: event.id });
      const ownIds = new Set(profiles.filter(profile => profile.email.trim().toLowerCase() === email).map(profile => profile.id));
      if (!ownIds.size) continue;
      const [audit, connections, messages, meetings] = await Promise.all([
        store.all("audit", { eventId: event.id }),
        store.all("connections", { eventId: event.id }),
        store.all("messages", { eventId: event.id }),
        store.all("meetings", { eventId: event.id }),
      ]);
      const byId = new Map(profiles.map(profile => [profile.id, profile]));
      const contacts = new Set<string>();
      for (const connection of connections) {
        if (!ownIds.has(connection.profileAId) && !ownIds.has(connection.profileBId)) continue;
        const otherId = ownIds.has(connection.profileAId) ? connection.profileBId : connection.profileAId;
        if (ownIds.has(otherId)) continue;
        contacts.add(byId.get(otherId)?.email.trim().toLowerCase() || otherId);
      }
      const ownMeetings = meetings.filter(meeting => ownIds.has(meeting.requesterId) || ownIds.has(meeting.recipientId));
      result.push({
        eventId: event.id, eventName: event.name,
        startsAt: event.startDate.toISOString(), endsAt: event.endDate.toISOString(),
        profileViews: audit.filter(entry => entry.action === "PROFILE_VIEW" && ownIds.has(entry.targetId ?? "")).length,
        matches: contacts.size,
        sentMessages: messages.filter(message => ownIds.has(message.senderId)).length,
        plannedMeetings: ownMeetings.filter(meeting => ["CONFIRMED", "COMPLETED", "NO_SHOW"].includes(meeting.status)).length,
        completedMeetings: ownMeetings.filter(meeting => meeting.status === "COMPLETED").length,
      });
    }
    result.sort((a,b) => b.startsAt.localeCompare(a.startsAt) || a.eventId.localeCompare(b.eventId));
    return { currentEventId: ctx.event.id, events: result };
  }
  async updateMe(ctx: NetworkingContext, input: Record<string, unknown>) {
    return networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.currentParticipant(ctx, store);
      const { consent, resetFields, ...fields } = input;
      const overrides = networkingProfileOverrides(ctx.profile.overrides);
      for (const key of (resetFields as string[] | undefined) ?? []) delete overrides[key];
      for (const field of ["company", "jobTitle", "sector"]) {
        if (field in fields) {
          if (typeof fields[field] !== "string" || !fields[field].trim())
            throw new BadRequestException(`${field} is required`);
          fields[field] = fields[field].trim();
        }
      }
      for (const [key, value] of Object.entries(networkingProfileOverrides({ ...fields, ...(consent !== undefined ? { consent } : {}) }))) {
        if (JSON.stringify(value) !== JSON.stringify(ctx.profile[key as keyof typeof ctx.profile]))
          overrides[key] = value;
      }
      if (
        typeof fields.language === "string" &&
        !ctx.config.languages.includes(fields.language as "fr" | "en" | "ar")
      )
        throw new BadRequestException(
          "This language is not enabled for the event",
        );
      const [row] = await store.update(
        "profiles",
        { id: ctx.profile.id, eventId: ctx.event.id },
        {
          ...fields,
          ...(consent !== undefined
            ? { consent: !!consent, consentAt: consent ? new Date() : null }
            : {}),
          overrides,
          ...(consent === false ? { visible: false } : {}),
        },
      );
      if (consent === false) {
        await revokeNetworkingSessions(ctx.profile.id, db);
        await cancelNetworkingParticipantMeetings(
          ctx.profile.id,
          ctx.event.id,
          db,
        );
      }
      if (Array.isArray(resetFields) && resetFields.length) {
        await syncNetworkingRegistration(ctx.profile.registrationId, db);
        return (await store.one("profiles", { id: row.id, eventId: ctx.event.id }))!;
      }
      return row;
    });
  }
}

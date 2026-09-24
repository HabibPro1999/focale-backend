import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes, randomInt } from "node:crypto";
import {
  findClientModuleState,
  listNetworkingDiscovery,
  networkingConsentPending,
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
import { ErrorCodes, NetworkingConfigSchema, networkingProfileComplete, networkingProfileOverrides, type ModuleId, type NetworkingConfig, type NetworkingPersonalAnalytics, type NetworkingRegistrationInfo } from "@app/contracts";
import { isModuleEnabledForClient } from "../clients/module-gates";
import { getConfig } from "../../core/config";
import {
  networkingBearerLockout,
  networkingBearerToken,
  networkingIdentityCache,
  networkingVenueKey,
} from "../../core/networking-identity-cache";
import { deleteNetworkingPhoto } from "./networking.uploads.service";
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
  /** Signed in without consent yet (K1b): only the consent allow-list may proceed. */
  consentPending?: boolean;
};
export type NetworkingAccess = "CONSENTED" | "CONSENT_PENDING";
const expired = (message = "Participant session expired") =>
  new UnauthorizedException({ code: ErrorCodes.NETWORKING_SESSION_EXPIRED, message });
const notFound = (message: string) => new NotFoundException({ code: ErrorCodes.NETWORKING_NOT_FOUND, message });
const unavailable = () => new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message: "Networking is not available for this event" });
const consentRequired = () =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_CONSENT_REQUIRED, message: "Networking consent is required" });
const bearer = (authorization?: string) => authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
/** Failed OTP verifications per (event, normalized email), summed across challenges. */
const OTP_FAILED_ATTEMPT_LIMITS = { recent: { windowMs: 15 * 60_000, max: 10 }, daily: { windowMs: 86_400_000, max: 30 } } as const;
const otpRateLimited = () =>
  new HttpException({ code: ErrorCodes.NETWORKING_RATE_LIMITED, message: "Too many verification attempts" }, HttpStatus.TOO_MANY_REQUESTS);
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
      if (!profile) throw new NotFoundException({
        code: ErrorCodes.NETWORKING_BADGE_INVALID,
        message: "Participant not found",
      });
      return profile.id;
    }
    return readNetworkingBadge(token, eventId);
  }
  async modulesEnabled(clientId: string, modules: ModuleId[] = ["networking", "registrations", "emails"]) {
    const client = await findClientModuleState(clientId);
    return modules.every((module) => isModuleEnabledForClient(client, module));
  }
  async publicContext(slug: string, store = networkingStore()) {
    const event = await store.one("events", { slug });
    if (!event) throw notFound("Event not found");
    if (!(await this.modulesEnabled(event.clientId))) throw unavailable();
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: event.id }))?.config ?? {},
    );
    if (!config.enabled || event.status === "ARCHIVED") throw unavailable();
    if (config.opensAt && Date.parse(config.opensAt) > Date.now())
      throw new ForbiddenException({ code: "NETWORKING_CLOSED", message: "Networking is not open yet" });
    if (config.closesAt && Date.parse(config.closesAt) < Date.now())
      throw new ForbiddenException({ code: "NETWORKING_CLOSED", message: "Networking has closed" });
    if (
      Date.now() >
      event.endDate.getTime() + config.retentionDays * 86_400_000
    )
      throw new ForbiddenException({ code: "NETWORKING_CLOSED", message: "Networking retention period has ended" });
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
    const networkingUrl = this.networkingUrl(event.slug);
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
      pushPublicKey: getConfig().networking.vapid.publicKey ?? null,
      networkingUrl,
    };
  }
  /** PWA event URL; an unset or invalid optional PUBLIC_NETWORKING_URL is omitted. */
  networkingUrl(slug: string) {
    try {
      const base = getConfig().networking.publicUrl;
      if (!base) return undefined;
      const url = new URL(base);
      if (!["http:", "https:"].includes(url.protocol)) return undefined;
      return `${url.origin}${url.pathname.replace(/\/$/, "")}/e/${encodeURIComponent(slug)}`;
    } catch {
      return undefined;
    }
  }
  /** Registration-form view (K2): available before opensAt, never throws for an unavailable event. */
  async registrationInfo(slug: string): Promise<NetworkingRegistrationInfo> {
    const store = networkingStore();
    const event = await store.one("events", { slug });
    if (!event) throw notFound("Event not found");
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: event.id }))?.config ?? {},
    );
    if (
      !config.enabled ||
      event.status === "ARCHIVED" ||
      (config.closesAt && Date.parse(config.closesAt) < Date.now()) ||
      Date.now() > event.endDate.getTime() + config.retentionDays * 86_400_000 ||
      !(await this.modulesEnabled(event.clientId))
    )
      return { enabled: false };
    const networkingUrl = this.networkingUrl(event.slug);
    return {
      enabled: true,
      opensAt: config.opensAt ?? null,
      closesAt: config.closesAt ?? null,
      approvalMode: config.approvalMode,
      fieldMapping: { ...config.fieldMapping, consent: config.fieldMapping.consent ?? null },
      ...(networkingUrl ? { networkingUrl } : {}),
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
  /** Consented and eligible: required by every capability and every visible counterpart. */
  async eligible(
    profile: NetworkingRow<"profiles">,
    config: NetworkingConfig,
    store = networkingStore(),
  ) {
    return (await this.access(profile, config, store, false)) === "CONSENTED";
  }
  /** Who may sign in: consented participants, or undecided registrants choosing in the PWA (K1b). */
  async access(
    profile: NetworkingRow<"profiles">,
    config: NetworkingConfig,
    store = networkingStore(),
    allowPending = true,
  ): Promise<NetworkingAccess | null> {
    if (profile.status !== "ACTIVE" || profile.withdrawnAt || (!profile.consent && !allowPending))
      return null;
    const registration = await store.one("registrations", {
      id: profile.registrationId,
      eventId: profile.eventId,
    });
    if (
      !registration ||
      registration.networkingOptIn === false ||
      !config.eligiblePaymentStatuses.includes(registration.paymentStatus)
    )
      return null;
    if (profile.consent) return "CONSENTED";
    const form = await store.one("forms", { id: registration.formId, eventId: profile.eventId });
    return networkingConsentPending({
      profile, optIn: registration.networkingOptIn, formSchema: form?.schema, formData: registration.formData, config,
    }) ? "CONSENT_PENDING" : null;
  }
  /**
   * `ip` is the client address the throttler keys venues by; with it, a rejected
   * bearer counts toward that venue's invalid-bearer lockout.
   */
  async participant(
    slug: string,
    authorization?: string,
    options: { allowPendingSecondFactor?: boolean; allowConsentPending?: boolean; ip?: string } = {},
  ): Promise<NetworkingContext> {
    const { event, config } = await this.publicContext(slug);
    const token = bearer(authorization);
    if (!token) throw this.rejectBearer(slug, authorization, options.ip, "Participant session required");
    const store = networkingStore();
    const session = await store.one("sessions", {
      eventId: event.id,
      tokenHash: networkingHash(token),
      revokedAt: null,
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw this.rejectBearer(slug, authorization, options.ip);
    // A live session: throttle this bearer as that session from now on.
    networkingIdentityCache.remember(token, session);
    const profile = await store.one("profiles", {
      id: session.profileId,
      eventId: event.id,
    });
    const access = profile ? await this.access(profile, config, store) : null;
    if (!profile || !access)
      throw new ForbiddenException({ code: "NETWORKING_NOT_ELIGIBLE", message: "Networking participation is not approved or eligible" });
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
    if (access === "CONSENT_PENDING" && !options.allowConsentPending) throw consentRequired();
    if (
      !profile.lastActiveAt ||
      Date.now() - profile.lastActiveAt.getTime() > 60_000
    )
      await touchNetworkingProfileActivity(event.id, profile.id);
    return { event, config, profile, session, consentPending: access === "CONSENT_PENDING" };
  }
  /** Forget a bearer the session lookup refused and count it toward the venue lockout. */
  private rejectBearer(slug: string, authorization: string | undefined, ip: string | undefined, message?: string) {
    const raw = networkingBearerToken(authorization);
    if (raw) {
      networkingIdentityCache.forgetToken(raw);
      if (ip !== undefined) networkingBearerLockout.recordRejected(networkingVenueKey(ip, slug), raw);
    }
    return expired(message);
  }
  /** Token-only: logging out never depends on eligibility, consent, MFA or the event window. */
  async logout(slug: string, authorization?: string) {
    const token = bearer(authorization);
    if (!token) throw expired("Participant session required");
    networkingIdentityCache.forgetToken(token);
    const store = networkingStore();
    const event = await store.one("events", { slug });
    if (event)
      await store.update(
        "sessions",
        { eventId: event.id, tokenHash: networkingHash(token), revokedAt: null },
        { revokedAt: new Date() },
      );
    return { loggedOut: true };
  }
  /** Revalidate capabilities inside the event transaction, after concurrent admin/session changes. */
  async currentParticipant(
    ctx: NetworkingContext,
    store: NetworkingStore,
    options: { allowConsentPending?: boolean } = {},
  ): Promise<NetworkingContext> {
    const event = await store.one("events", { id: ctx.event.id });
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: ctx.event.id }))?.config ?? {},
    );
    if (
      !event ||
      event.status === "ARCHIVED" ||
      !config.enabled
    )
      throw unavailable();
    if (
      (config.opensAt && Date.parse(config.opensAt) > Date.now()) ||
      (config.closesAt && Date.parse(config.closesAt) <= Date.now()) ||
      event.endDate.getTime() + config.retentionDays * 86400000 < Date.now()
    )
      throw new ForbiddenException({ code: "NETWORKING_CLOSED", message: "Networking is not available for this event" });
    if (!(await this.modulesEnabled(event.clientId, ["networking"]))) throw unavailable();
    const session = await store.one("sessions", {
      id: ctx.session.id,
      eventId: event.id,
      profileId: ctx.profile.id,
      revokedAt: null,
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      networkingIdentityCache.forgetSession(ctx.session.id);
      throw expired();
    }
    const profile = await store.one("profiles", {
      id: ctx.profile.id,
      eventId: event.id,
    });
    const access = profile ? await this.access(profile, config, store, !!options.allowConsentPending) : null;
    if (!profile || !access)
      throw new ForbiddenException({ code: "NETWORKING_NOT_ELIGIBLE", message: "Networking participation is no longer eligible" });
    const factor = await store.one("secondFactors", { profileId: profile.id });
    if (
      (config.requireSecondFactor || factor?.enabledAt) &&
      !session.secondFactorVerifiedAt
    )
      throw new ForbiddenException({
        code: "NETWORKING_MFA_REQUIRED",
        message: "Authenticator verification is required",
      });
    return { event, config, profile, session, consentPending: access === "CONSENT_PENDING" };
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
        if (await this.access(candidate, config, store)) {
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
      // Checked before the code is compared, so a limited address learns nothing about it.
      // The event lock taken by networkingTransaction serializes concurrent attempts.
      const now = Date.now();
      const failed = await store.failedOtpAttempts(
        event.id,
        challenge.email,
        new Date(now - OTP_FAILED_ATTEMPT_LIMITS.recent.windowMs),
        new Date(now - OTP_FAILED_ATTEMPT_LIMITS.daily.windowMs),
      );
      if (
        failed.recent >= OTP_FAILED_ATTEMPT_LIMITS.recent.max ||
        failed.daily >= OTP_FAILED_ATTEMPT_LIMITS.daily.max
      )
        return "rate-limited" as const;
      const valid =
        challenge.codeHash ===
        networkingHash(`otp:${event.id}:${challenge.email}:${code}`);
      await store.update(
        "challenges",
        { id: challenge.id, eventId: event.id },
        {
          attempts: challenge.attempts + 1,
          ...(valid ? { consumedAt: new Date(), verifiedAt: new Date() } : {}),
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
        if (!(await this.access(profile, config, store))) continue;
        const token = randomBytes(48).toString("base64url");
        const expiresAt = new Date(Date.now() + 30 * 86_400_000);
        const session = await store.insert("sessions", {
          eventId: event.id,
          profileId: profile.id,
          tokenHash: networkingHash(token),
          expiresAt,
        });
        const factor = await store.one("secondFactors", {
          profileId: profile.id,
        });
        return {
          session,
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
    if (result === "rate-limited") throw otpRateLimited();
    // Stays 401 (no session issued); NETWORKING_VALIDATION is reserved for HTTP 400.
    if (!result)
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: "Invalid or expired verification code" });
    const { session, ...issued } = result;
    // Committed and verified: the new bearer is throttled as its session from the first request.
    networkingIdentityCache.remember(issued.token, session);
    return issued;
  }
  async target(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
    visible = false,
  ) {
    if (id === ctx.profile.id)
      throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Choose another participant" });
    const profile = await store.one("profiles", { id, eventId: ctx.event.id });
    if (
      !profile ||
      profile.email.trim().toLowerCase() ===
        ctx.profile.email.trim().toLowerCase() ||
      !(await this.eligible(profile, ctx.config, store)) ||
      (visible && (!profile.visible || !networkingProfileComplete(profile)))
    )
      throw notFound("Participant not available");
    const current = await store.one("profiles", {
      id: ctx.profile.id,
      eventId: ctx.event.id,
    });
    if (!current || !(await this.eligible(current, ctx.config, store)))
      throw new ForbiddenException({ code: "NETWORKING_NOT_ELIGIBLE", message: "Networking participation is no longer eligible" });
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
        throw notFound("Participant not available");
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
    if (blocked) throw notFound("Participant not available");
    return profile;
  }
  async discover(ctx: NetworkingContext, query: NetworkingDiscoveryQuery = {}) {
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled)
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Discovery is disabled" });
    if (
      (query.q ||
        query.sector ||
        query.sectors?.length ||
        query.company ||
        query.city ||
        query.country) &&
      !ctx.config.searchEnabled
    )
      throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Search is disabled" });
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
    if (!ctx.config.swipeEnabled && !ctx.config.searchEnabled) throw new ForbiddenException({ code: "NETWORKING_FEATURE_DISABLED", message: "Discovery is disabled" });
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
    const profiles = await store.personalAnalyticsProfiles(ctx.event.clientId, email);
    const events = new Map(profiles.map(profile => [profile.eventId, profile]));
    const result: NetworkingPersonalAnalytics["events"] = [];
    for (const event of events.values()) {
      const ownIds = profiles.filter(profile => profile.eventId === event.eventId).map(profile => profile.id);
      result.push({
        eventId: event.eventId, eventName: event.name,
        startsAt: event.startDate.toISOString(), endsAt: event.endDate.toISOString(),
        ...(await store.personalAnalyticsCounts(event.eventId, ownIds)),
      });
    }
    result.sort((a,b) => b.startsAt.localeCompare(a.startsAt) || a.eventId.localeCompare(b.eventId));
    return { currentEventId: ctx.event.id, events: result };
  }
  async updateMe(ctx: NetworkingContext, input: Record<string, unknown>) {
    const { row, previousPhotoUrl } = await networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.currentParticipant(ctx, store, { allowConsentPending: ctx.consentPending });
      const previousPhotoUrl = ctx.profile.photoUrl;
      // A consent-pending session may only record its consent choice (K1b).
      if (ctx.consentPending) input = input.consent === undefined ? {} : { consent: input.consent };
      const { consent, resetFields, ...fields } = input;
      const overrides = networkingProfileOverrides(ctx.profile.overrides);
      for (const key of (resetFields as string[] | undefined) ?? []) delete overrides[key];
      for (const field of ["company", "jobTitle", "sector"]) {
        if (field in fields) {
          if (typeof fields[field] !== "string" || !fields[field].trim())
            throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: `${field} is required` });
          fields[field] = fields[field].trim();
        }
      }
      for (const [key, value] of Object.entries(networkingProfileOverrides(fields))) {
        if (JSON.stringify(value) !== JSON.stringify(ctx.profile[key as keyof typeof ctx.profile]))
          overrides[key] = value;
      }
      // An explicit PWA choice outranks the mapped form answer (K1).
      if (typeof consent === "boolean") overrides.consent = consent;
      if (
        typeof fields.language === "string" &&
        !ctx.config.languages.includes(fields.language as "fr" | "en" | "ar")
      )
        throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "This language is not enabled for the event" });
      const [row] = await store.update(
        "profiles",
        { id: ctx.profile.id, eventId: ctx.event.id },
        {
          ...fields,
          ...(consent !== undefined
            ? { consent: !!consent, consentAt: consent ? new Date() : null }
            : {}),
          overrides,
          ...(consent === false ? { visible: false } : consent === true && !ctx.profile.consent ? { visible: true } : {}),
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
        return { row: (await store.one("profiles", { id: row.id, eventId: ctx.event.id }))!, previousPhotoUrl };
      }
      return { row, previousPhotoUrl };
    });
    // Declining consent revoked the sessions; a registration re-sync may have revoked them too.
    const { consent, resetFields } = input;
    if (consent === false || (Array.isArray(resetFields) && resetFields.length))
      networkingIdentityCache.forgetProfile(ctx.profile.id);
    // Replaced, removed or reset photos are deleted after commit, and only from the participant's own prefix.
    if (row.photoUrl !== previousPhotoUrl) await deleteNetworkingPhoto(previousPhotoUrl, ctx.event.id, ctx.profile.id);
    return row;
  }
}

import { requestNetworkingCode, verifyNetworkingCode, logoutNetworkingSession } from "./networking.auth";
import { updateNetworkingProfile, networkingPersonalAnalytics, withdrawNetworkingParticipant, networkingParticipantBadge } from "./networking.profile";
import { discoverNetworkingProfiles, networkingRepresentatives, networkingFacets, viewNetworkingProfile } from "./networking.discovery";
import { networkingNotFound, networkingSessionExpired as expired, assertNetworkingSecondFactor } from "./networking.errors";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  getDb,
  findClientModuleState,
  networkingAreaAccess,
  networkingCounterpartVisible,
  networkingDiscoveryEnabled,
  networkingEventAvailable,
  networkingParticipantAccess,
  networkingParticipantEligible,
  networkingWindow,
  touchNetworkingProfileActivity,
  networkingStore,
  type NetworkingAccess,
  type NetworkingDiscoveryFilters,
  type NetworkingRow,
  type NetworkingStore,
  type NetworkingWindow,
} from "@app/db";
import { ErrorCodes, NetworkingConfigSchema, type NetworkingConfig, type NetworkingPersonalAnalytics, type NetworkingRegistrationInfo } from "@app/contracts";
import { getConfig } from "../../core/config";
import {
  networkingBearerLockout,
  networkingBearerToken,
  networkingIdentityCache,
  networkingVenueKey,
} from "../../core/networking-identity-cache";
import {
  networkingSessionHashes,
  parseNetworkingSessionToken as bearer,
  readNetworkingBadge,
} from "./networking.security";
export type NetworkingContext = {
  event: NetworkingRow<"events">;
  config: NetworkingConfig;
  profile: NetworkingRow<"profiles">;
  session: NetworkingRow<"sessions">;
  /** Signed in without consent yet (K1b): only the consent allow-list may proceed. */
  consentPending?: boolean;
};
export type { NetworkingAccess };
const unavailable = () => new ForbiddenException({ code: ErrorCodes.NETWORKING_FEATURE_DISABLED, message: "Networking is not available for this event" });
const notEligible = (message = "Networking participation is no longer eligible") =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_NOT_ELIGIBLE, message });
const closedMessages: Record<Exclude<NetworkingWindow, "OPEN">, string> = {
  NOT_YET_OPEN: "Networking is not open yet",
  CLOSED: "Networking has closed",
  RETENTION_ENDED: "Networking retention period has ended",
};
const closed = (message: string) => new ForbiddenException({ code: ErrorCodes.NETWORKING_CLOSED, message });
const consentRequired = () =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_CONSENT_REQUIRED, message: "Networking consent is required" });
export type NetworkingDiscoveryQuery = NetworkingDiscoveryFilters;
@Injectable()
export class NetworkingService {
  async badgeProfileId(eventId: string, token: string, store = networkingStore(getDb())) {
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
  /** The event gate and window (4.6 policy), for anonymous and participant routes alike. */
  async publicContext(slug: string) {
    const store = networkingStore(getDb());
    const event = await store.one("events", { slug });
    if (!event) throw networkingNotFound("Event not found");
    const client = await findClientModuleState(event.clientId);
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: event.id }))?.config ?? {},
    );
    if (!networkingEventAvailable({ event, client, config })) throw unavailable();
    const window = networkingWindow(config, event);
    if (window !== "OPEN") throw closed(closedMessages[window]);
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
    const store = networkingStore(getDb());
    const event = await store.one("events", { slug });
    if (!event) throw networkingNotFound("Event not found");
    const config = NetworkingConfigSchema.parse(
      (await store.one("configs", { eventId: event.id }))?.config ?? {},
    );
    // Shown before opensAt, so the form can announce networking early.
    const window = networkingWindow(config, event);
    if (
      !networkingEventAvailable({ event, client: await findClientModuleState(event.clientId), config }) ||
      window === "CLOSED" ||
      window === "RETENTION_ENDED"
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
  /** Admitted to the networking area (badge, organizer scan): the check-in admission rule (4.6). */
  async areaAccess(
    ctx: Pick<NetworkingContext, "event" | "config" | "profile">,
    accessId = ctx.config.requiredAccessId,
  ) {
    return networkingAreaAccess({
      eventId: ctx.event.id,
      profileId: ctx.profile.id,
      statuses: ctx.config.eligiblePaymentStatuses,
      accessId,
    });
  }
  /** Consented and eligible (4.6 policy): required by every capability and every visible counterpart. */
  async eligible(
    profile: NetworkingRow<"profiles">,
    config: NetworkingConfig,
    store = networkingStore(getDb()),
  ) {
    const registration = await store.one("registrations", { id: profile.registrationId });
    return networkingParticipantEligible({ profile, registration }, config);
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
    const store = networkingStore(getDb());
    // Any key in the keyring may have hashed this token; the first candidate is the current format.
    const [currentHash, ...olderHashes] = networkingSessionHashes(token);
    const session = await store.sessionByTokenHashes(event.id, [currentHash!, ...olderHashes]);
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw this.rejectBearer(slug, authorization, options.ip);
    if (session.tokenHash !== currentHash) {
      // Rehash on use, so retired keys stop being needed within one session lifetime.
      await store.rehashSession(event.id, session.id, session.tokenHash, currentHash!).catch(() => undefined);
      session.tokenHash = currentHash!;
    }
    // A live session: throttle this bearer as that session from now on.
    networkingIdentityCache.remember(token, session);
    // Profile, registration, form (unconsented) and second factor in one read (4.6).
    const snapshot = await store.participantSnapshot({ eventId: event.id, clientId: event.clientId, profileId: session.profileId });
    const access = snapshot ? networkingParticipantAccess(snapshot, config) : null;
    if (!snapshot?.profile || !access) throw notEligible("Networking participation is not approved or eligible");
    const profile = snapshot.profile;
    assertNetworkingSecondFactor(config, snapshot.secondFactorEnabled, session, { allowPending: options.allowPendingSecondFactor });
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
    return logoutNetworkingSession(slug, authorization);
  }
  /**
   * Revalidate capabilities inside the networking transaction, after concurrent
   * admin/session changes. The event row comes from the request context and is
   * not re-read: registrations bump its counters, and reading it in every
   * SERIALIZABLE participant write would turn registration surges into
   * networking retries.
   */
  async currentParticipant(
    ctx: NetworkingContext,
    store: NetworkingStore,
    options: { allowConsentPending?: boolean } = {},
  ): Promise<NetworkingContext> {
    const event = ctx.event;
    // Config, client modules, session, profile, registration and second factor in one read (4.6).
    const snapshot = await store.participantSnapshot({
      eventId: event.id,
      clientId: event.clientId,
      profileId: ctx.profile.id,
      sessionId: ctx.session.id,
    });
    const config = snapshot?.config ?? NetworkingConfigSchema.parse({});
    if (!snapshot || !networkingEventAvailable({ event, client: snapshot.client, config })) throw unavailable();
    if (networkingWindow(config, event) !== "OPEN") throw closed("Networking is not available for this event");
    const session = snapshot.session;
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      networkingIdentityCache.forgetSession(ctx.session.id);
      throw expired();
    }
    const profile = snapshot.profile;
    const access = networkingParticipantAccess(snapshot, config, { allowConsentPending: !!options.allowConsentPending });
    if (!profile || !access) throw notEligible();
    assertNetworkingSecondFactor(config, snapshot.secondFactorEnabled, session);
    return { event, config, profile, session, consentPending: access === "CONSENT_PENDING" };
  }
  async requestCode(slug: string, email: string) {
    return requestNetworkingCode(this, slug, email);
  }
  async verifyCode(slug: string, challengeId: string, code: string) {
    return verifyNetworkingCode(this, slug, challengeId, code);
  }
  /**
   * The participant `id` as `ctx`'s participant may see it (4.6 counterpart
   * policy): `profile` mode, or `discover` mode for `visible` (swipes). The
   * viewer's own eligibility is re-read in the same statement.
   */
  async target(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(getDb()),
    visible = false,
  ) {
    const snapshot = await this.counterpart(ctx, id, store);
    if (!snapshot.target || !networkingCounterpartVisible(snapshot, ctx.config, visible ? "discover" : "profile"))
      throw networkingNotFound("Participant not available");
    return snapshot.target;
  }
  /**
   * A participant on the viewer's block list: its profile while the policy
   * still lets the viewer see it (the block edge itself is ignored: it is why
   * the row is listed, and unblocking removes it), else null.
   */
  async blockedTarget(ctx: NetworkingContext, id: string, store = networkingStore(getDb())) {
    const snapshot = await this.counterpart(ctx, id, store);
    return snapshot.target && networkingCounterpartVisible(snapshot, ctx.config, "blocklist") ? snapshot.target : null;
  }
  /**
   * `target()` for a list (4.9): of `ids`, the counterparts the viewer may see
   * in `profile` mode, and the viewer's own current row, in one statement. As
   * in target(), the viewer must still be eligible once any counterpart exists.
   */
  async visibleCounterparts(ctx: NetworkingContext, ids: readonly string[], store = networkingStore(getDb())) {
    const found = await store.profileCounterparts({
      eventId: ctx.event.id,
      viewerId: ctx.profile.id,
      targetIds: ids.filter((id) => id !== ctx.profile.id),
      statuses: ctx.config.eligiblePaymentStatuses,
      discoveryEnabled: networkingDiscoveryEnabled(ctx.config),
    });
    if (found.targets.length && (!found.viewer || !networkingParticipantEligible(found.viewer, ctx.config)))
      throw notEligible();
    return {
      viewer: found.viewer?.profile ?? null,
      visible: new Map(found.targets.filter((target) => target.visible).map((target) => [target.profile.id, target.profile])),
    };
  }
  /** Viewer and target facts in one read; the viewer must still be eligible. */
  private async counterpart(ctx: NetworkingContext, id: string, store: NetworkingStore) {
    if (id === ctx.profile.id)
      throw new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message: "Choose another participant" });
    const snapshot = await store.counterpartSnapshot({ eventId: ctx.event.id, viewerId: ctx.profile.id, targetId: id });
    if (!snapshot || !networkingParticipantEligible({ profile: snapshot.viewer, registration: snapshot.viewerRegistration }, ctx.config))
      throw notEligible();
    return { ...snapshot, viewer: { id: snapshot.viewer.id, email: snapshot.viewer.email } };
  }
  async discover(ctx: NetworkingContext, query: NetworkingDiscoveryQuery = {}) {
    return discoverNetworkingProfiles(ctx, query);
  }

  async representatives(ctx: NetworkingContext, profileId: string, page = 1) {
    return networkingRepresentatives(this, ctx, profileId, page);
  }

  async personalAnalytics(ctx: NetworkingContext): Promise<NetworkingPersonalAnalytics> {
    return networkingPersonalAnalytics(this, ctx);
  }
  async updateMe(ctx: NetworkingContext, input: Record<string, unknown>) {
    return updateNetworkingProfile(this, ctx, input);
  }
  facets(ctx: NetworkingContext) { return networkingFacets(ctx); }
  profile(ctx: NetworkingContext, id: string, viewId?: string) { return viewNetworkingProfile(this, ctx, id, viewId); }
  badge(ctx: NetworkingContext) { return networkingParticipantBadge(this, ctx); }
  withdraw(ctx: NetworkingContext) { return withdrawNetworkingParticipant(ctx); }
}

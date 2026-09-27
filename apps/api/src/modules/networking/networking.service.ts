import { networkingDirectoryFacets, recordNetworkingProfileView } from "@app/db";
import { issueNetworkingBadge } from "./networking.security";
import {
  networkingSessionExpired as expired,
  networkingBearer as bearer,
} from "./networking.session-policy";
import {
  networkingValidation,
  networkingFeatureDisabled,
  networkingNotEligible,
  networkingNotFound as notFound,
} from "./networking.errors";
import { activeStand } from "./networking.stand";
import { loadNetworkingConfig } from "./networking.config";

import {
  networkingWindow,
  requireDiscovery,
  networkingPair,
  networkingPublicProfile,
} from "./networking.policy";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  findClientModuleState,
  listNetworkingDiscovery,
  networkingConsentPending,
  touchNetworkingProfileActivity,
  getActiveEventAccessId,
  networkingStore,
  type DbExecutor,
  type NetworkingRow,
  type NetworkingStore,
} from "@app/db";
import {
  ErrorCodes,
  networkingProfileComplete,
  type ModuleId,
  type NetworkingConfig,
  type NetworkingRegistrationInfo,
} from "@app/contracts";
import { isModuleEnabledForClient } from "../clients/module-gates";
import { getConfig } from "../../core/config";
import {
  networkingBearerLockout,
  networkingBearerToken,
  networkingIdentityCache,
  networkingVenueKey,
} from "../../core/networking-identity-cache";
import { networkingHash, readNetworkingBadge } from "./networking.security";

export type NetworkingContext = {
  event: NetworkingRow<"events">;
  config: NetworkingConfig;
  profile: NetworkingRow<"profiles">;
  session: NetworkingRow<"sessions">;
  /** Signed in without consent yet (K1b): only the consent allow-list may proceed. */
  consentPending?: boolean;
};
export type NetworkingAccess = "CONSENTED" | "CONSENT_PENDING";
const unavailable = () => networkingFeatureDisabled("Networking is not available for this event");
const consentRequired = () =>
  new ForbiddenException({ code: ErrorCodes.NETWORKING_CONSENT_REQUIRED, message: "Networking consent is required" });
export type NetworkingDiscoveryQuery = import("@app/db").NetworkingDiscoveryFilters;
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
  /** Inside a networking transaction pass its executor: the check must not take a second pool connection. */
  async modulesEnabled(
    clientId: string,
    modules: ModuleId[] = ["networking", "registrations", "emails"],
    db?: DbExecutor,
  ) {
    const client = await findClientModuleState(clientId, db);
    return modules.every((module) => isModuleEnabledForClient(client, module));
  }
  async publicContext(slug: string) {
    const store = networkingStore();
    const event = await store.one("events", { slug });
    if (!event) throw notFound("Event not found");
    if (!(await this.modulesEnabled(event.clientId))) throw unavailable();
    const config = await loadNetworkingConfig(store, event.id);
    const window = networkingWindow(event, config);
    if (window === "DISABLED") throw unavailable();
    if (window !== "OPEN") {
      const message = {
        NOT_OPEN: "Networking is not open yet",
        CLOSED: "Networking has closed",
        RETENTION_ENDED: "Networking retention period has ended",
      }[window];
      throw new ForbiddenException({ code: ErrorCodes.NETWORKING_CLOSED, message });
    }
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
    const config = await loadNetworkingConfig(store, event.id);
    if (
      networkingWindow(event, config, Date.now, { skipOpening: true }) !== "OPEN" ||
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
    return (await this.access(profile, config, store, { allowPending: false })) === "CONSENTED";
  }
  /** Who may sign in: consented participants, or undecided registrants choosing in the PWA (K1b). */
  async access(
    profile: NetworkingRow<"profiles">,
    config: NetworkingConfig,
    store = networkingStore(),
    { allowPending = true }: { allowPending?: boolean } = {},
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
      throw networkingNotEligible("Networking participation is not approved or eligible");
    await this.assertSecondFactor(store, config, profile, session, options.allowPendingSecondFactor);
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
    const config = await loadNetworkingConfig(store, event.id);
    const window = networkingWindow(event, config, Date.now, { closeAtBoundary: true });
    if (window === "DISABLED") throw unavailable();
    if (window !== "OPEN")
      throw new ForbiddenException({ code: ErrorCodes.NETWORKING_CLOSED, message: "Networking is not available for this event" });
    if (!(await this.modulesEnabled(event.clientId, ["networking"], store.executor))) throw unavailable();
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
    const access = profile ? await this.access(profile, config, store, { allowPending: !!options.allowConsentPending }) : null;
    if (!profile || !access)
      throw networkingNotEligible("Networking participation is no longer eligible");
    await this.assertSecondFactor(store, config, profile, session);
    return { event, config, profile, session, consentPending: access === "CONSENT_PENDING" };
  }
  async target(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
    options: { requireDiscoverable?: boolean } = {},
  ) {
    const profile = await this.findCounterpart(ctx, id, store, options);
    if (!profile) throw notFound("Participant not available");
    return profile;
  }
  /** Nullable target policy, including both block directions. */
  findCounterpart(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
    options: { requireDiscoverable?: boolean } = {},
  ) {
    return this.lookupCounterpart(ctx, id, store, options, true);
  }
  /** Only the blocked list may retain its actionable block edge. */
  findBlockedCounterpart(ctx: NetworkingContext, id: string, store: NetworkingStore) {
    return this.lookupCounterpart(ctx, id, store, {}, false);
  }
  private async lookupCounterpart(
    ctx: NetworkingContext,
    id: string,
    store = networkingStore(),
    options: { requireDiscoverable?: boolean },
    checkBlocks: boolean,
  ) {
    const visible = options.requireDiscoverable ?? false;
    if (id === ctx.profile.id)
      throw networkingValidation("Choose another participant");
    const profile = await store.one("profiles", { id, eventId: ctx.event.id });
    if (
      !profile ||
      profile.email.trim().toLowerCase() ===
        ctx.profile.email.trim().toLowerCase() ||
      !(await this.eligible(profile, ctx.config, store)) ||
      (visible && (!profile.visible || !networkingProfileComplete(profile)))
    )
      return null;
    const current = await store.one("profiles", {
      id: ctx.profile.id,
      eventId: ctx.event.id,
    });
    if (!current || !(await this.eligible(current, ctx.config, store)))
      throw networkingNotEligible("Networking participation is no longer eligible");
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
        return null;
    }
    const blocked = checkBlocks && (
      (await store.one("blocks", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
        targetId: id,
      })) ||
      (await store.one("blocks", {
        eventId: ctx.event.id,
        profileId: id,
        targetId: ctx.profile.id,
      })));
    if (blocked) return null;
    return profile;
  }
  async discover(ctx: NetworkingContext, query: NetworkingDiscoveryQuery = {}) {
    requireDiscovery(ctx);
    if (
      (query.q ||
        query.sector ||
        query.sectors?.length ||
        query.company ||
        query.city ||
        query.country) &&
      !ctx.config.searchEnabled
    )
      throw networkingFeatureDisabled("Search is disabled");
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
    requireDiscovery(ctx);
    const profile = await this.target(ctx, profileId);
    const active = profile.standTableId ? await activeStand(networkingStore(), ctx.event.id, profile.standTableId) : null;
    if (!active) return { items: [], total: 0, exhibitor: null };
    const { stand, space } = active;
    const result = await listNetworkingDiscovery(ctx.event.id, ctx.profile.id, ctx.config.eligiblePaymentStatuses,
      { standTableId: stand.id, page, limit: 30 });
    return { items: result.items.map(networkingPublicProfile), total: result.total,
      exhibitor: { id: stand.id, name: stand.name, spaceName: space?.name ?? null } };
  }
  private async assertSecondFactor(
    store: NetworkingStore,
    config: NetworkingConfig,
    profile: NetworkingRow<"profiles">,
    session: NetworkingRow<"sessions">,
    allowPending = false,
  ) {
    const factor = await store.one("secondFactors", { profileId: profile.id });
    if ((config.requireSecondFactor || factor?.enabledAt) && !session.secondFactorVerifiedAt && !allowPending)
      throw new ForbiddenException({
        code: ErrorCodes.NETWORKING_MFA_REQUIRED,
        message: "Authenticator verification is required",
      });
  }
  async facets(ctx: NetworkingContext) {
    if (!ctx.config.searchEnabled)
      throw networkingFeatureDisabled("Search is disabled");
    return networkingDirectoryFacets(
      ctx.event.id,
      ctx.profile.id,
      ctx.config.eligiblePaymentStatuses,
    );
  }
  async badge(ctx: NetworkingContext) {
    return {
      ...issueNetworkingBadge(ctx.profile.id, ctx.event.id),
      accessAllowed: await this.areaAccess(ctx),
    };
  }
  async viewProfile(ctx: NetworkingContext, id: string, viewId?: string) {
    const profile = await this.target(ctx, id);
    await recordNetworkingProfileView(ctx.event.id, ctx.profile.id, id, viewId);
    return networkingPublicProfile(profile);
  }
}

import { networkingProfileComplete, type NetworkingConfig } from "@app/contracts";

/**
 * The networking eligibility policy (plan 4.6), as pure functions over rows
 * already loaded. Every surface that decides who may use networking, or who
 * may see whom, asks these functions (in TypeScript) or their SQL twins in
 * `networking-eligibility.ts` (in queries). The fixture matrix in
 * `testing/networking-eligibility-matrix.ts` runs both against the same rows.
 *
 * Layers:
 * - gate: the event offers networking at all (config, event, client modules);
 * - window: the configured opening, closing and retention times;
 * - participant: a profile may act (consented) or only record consent;
 * - counterpart: what one participant may see of another, per mode.
 *
 * Withdrawn and erased profiles are ineligible everywhere.
 */

/** Client modules networking depends on (sign-in codes are emails; profiles are registrations). */
export const NETWORKING_REQUIRED_MODULES = ["networking", "registrations", "emails"] as const;

export type NetworkingGateFacts = {
  event: { status: string } | null | undefined;
  client: { active: boolean; enabledModules: readonly string[] | null } | null | undefined;
  config: Pick<NetworkingConfig, "enabled">;
};

/** The event offers networking: enabled, not archived, client active with every required module. */
export function networkingEventAvailable(facts: NetworkingGateFacts): boolean {
  const { event, client, config } = facts;
  return (
    !!event &&
    event.status !== "ARCHIVED" &&
    config.enabled &&
    !!client?.active &&
    Array.isArray(client.enabledModules) &&
    NETWORKING_REQUIRED_MODULES.every((module) => client.enabledModules!.includes(module))
  );
}

export type NetworkingWindow = "OPEN" | "NOT_YET_OPEN" | "CLOSED" | "RETENTION_ENDED";

/** Where `now` falls in the configured opening window and the retention period. */
export function networkingWindow(
  config: Pick<NetworkingConfig, "opensAt" | "closesAt" | "retentionDays">,
  event: { endDate: Date },
  now: number = Date.now(),
): NetworkingWindow {
  if (now > event.endDate.getTime() + config.retentionDays * 86_400_000) return "RETENTION_ENDED";
  if (config.closesAt && Date.parse(config.closesAt) <= now) return "CLOSED";
  if (config.opensAt && Date.parse(config.opensAt) > now) return "NOT_YET_OPEN";
  return "OPEN";
}

export type NetworkingAccess = "CONSENTED" | "CONSENT_PENDING";

/** The registration's payment status is one the event admits to networking. */
export function networkingPaymentEligible(
  registration: { paymentStatus: string },
  config: Pick<NetworkingConfig, "eligiblePaymentStatuses">,
): boolean {
  return (config.eligiblePaymentStatuses as readonly string[]).includes(registration.paymentStatus);
}

/** The profile columns participant eligibility reads. */
export type NetworkingAccessProfile = {
  eventId: string;
  status: string;
  consent: boolean;
  withdrawnAt: Date | null;
  erasedAt: Date | null;
};
/** The registration columns participant eligibility reads. */
export type NetworkingAccessRegistration = {
  eventId: string;
  paymentStatus: string;
  networkingOptIn: boolean | null;
};
export type NetworkingParticipantFacts = {
  profile: NetworkingAccessProfile | null | undefined;
  /** The profile's own registration (by `profile.registrationId`). */
  registration: NetworkingAccessRegistration | null | undefined;
  /**
   * For an unconsented profile: whether its registration leaves consent
   * undecided (`networkingConsentPending`, K1b). Ignored once consented.
   */
  consentPending?: boolean;
};

/**
 * Participant access: `CONSENTED` may use networking; `CONSENT_PENDING` may
 * only sign in and record consent (K1b); null may do neither. Requires an
 * ACTIVE, never withdrawn or erased profile whose own registration (in the
 * same event) did not opt out and has an eligible payment status.
 */
export function networkingParticipantAccess(
  facts: NetworkingParticipantFacts,
  config: Pick<NetworkingConfig, "eligiblePaymentStatuses">,
  options: { allowConsentPending?: boolean } = {},
): NetworkingAccess | null {
  const { profile, registration } = facts;
  if (!profile || !registration) return null;
  if (profile.status !== "ACTIVE" || profile.withdrawnAt || profile.erasedAt) return null;
  if (registration.eventId !== profile.eventId || registration.networkingOptIn === false) return null;
  if (!networkingPaymentEligible(registration, config)) return null;
  if (profile.consent) return "CONSENTED";
  return options.allowConsentPending !== false && facts.consentPending === true ? "CONSENT_PENDING" : null;
}

/** Consented and eligible: required for every capability and of every visible counterpart. */
export function networkingParticipantEligible(
  facts: Omit<NetworkingParticipantFacts, "consentPending">,
  config: Pick<NetworkingConfig, "eligiblePaymentStatuses">,
): boolean {
  return networkingParticipantAccess(facts, config, { allowConsentPending: false }) === "CONSENTED";
}

/**
 * What a participant may see of another:
 * - `peer`: the relationship (a connection, a meeting) is already given by the
 *   caller, e.g. a connection list, a meeting reminder or a notification's
 *   contact; no visibility requirement.
 * - `discover`: discovery lists, search, recommendations and swipes: the
 *   counterpart is visible with a complete profile and discovery is enabled.
 * - `profile`: a profile opened directly: discoverable as above, or connected.
 * - `blocklist`: the viewer's own block list: like `profile`, but the block
 *   edge (why the row is listed, and what unblocking removes) is ignored.
 */
export type NetworkingCounterpartMode = "peer" | "discover" | "profile" | "blocklist";

export type NetworkingCounterpartProfile = NetworkingAccessProfile & {
  id: string;
  email: string;
  visible: boolean;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  sector: string;
};
export type NetworkingCounterpartFacts = {
  viewer: { id: string; email: string };
  target: NetworkingCounterpartProfile | null | undefined;
  targetRegistration: NetworkingAccessRegistration | null | undefined;
  /** A block exists in either direction between viewer and target. */
  blocked: boolean;
  /** Viewer and target share a connection. */
  connected: boolean;
};

/** Discovery shows only visible participants with a complete professional profile. */
export function networkingProfileDiscoverable(profile: Pick<NetworkingCounterpartProfile, "visible" | "firstName" | "lastName" | "company" | "jobTitle" | "sector">): boolean {
  return profile.visible && networkingProfileComplete(profile);
}

/** A participant's identity: the address, trimmed and case-folded (SQL: `lower(btrim(email))`). */
export function networkingIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Two profiles of one person (same address, case-insensitive) never see each other. */
export function networkingDistinctIdentity(viewer: { id: string; email: string }, target: { id: string; email: string }): boolean {
  return viewer.id !== target.id && networkingIdentityEmail(viewer.email) !== networkingIdentityEmail(target.email);
}

/** The discovery features are on (swipe or search). */
export function networkingDiscoveryEnabled(config: Pick<NetworkingConfig, "swipeEnabled" | "searchEnabled">): boolean {
  return config.swipeEnabled || config.searchEnabled;
}

/** Whether the viewer may see the target in `mode` (the viewer's own access is checked separately). */
export function networkingCounterpartVisible(
  facts: NetworkingCounterpartFacts,
  config: Pick<NetworkingConfig, "eligiblePaymentStatuses" | "swipeEnabled" | "searchEnabled">,
  mode: NetworkingCounterpartMode,
): boolean {
  const { viewer, target } = facts;
  if (!target || !networkingDistinctIdentity(viewer, target)) return false;
  if (!networkingParticipantEligible({ profile: target, registration: facts.targetRegistration }, config)) return false;
  if (mode !== "blocklist" && facts.blocked) return false;
  if (mode === "peer") return true;
  const discoverable = networkingProfileDiscoverable(target) && networkingDiscoveryEnabled(config);
  return mode === "discover" ? discoverable : discoverable || facts.connected;
}

/**
 * Embedded for recommendations: consented, eligible and visible. Only these
 * profiles get embedding jobs; the admin embedding status counts them.
 */
export function networkingProfileEmbeddable(
  facts: Omit<NetworkingParticipantFacts, "consentPending"> & { profile: (NetworkingAccessProfile & { visible: boolean }) | null | undefined },
  config: Pick<NetworkingConfig, "eligiblePaymentStatuses">,
): boolean {
  return !!facts.profile?.visible && networkingParticipantEligible(facts, config);
}

/** Organizer lists, exports and counts: an erased profile is a tombstone with nothing to show. */
export function networkingProfileListed(profile: { erasedAt: Date | null }): boolean {
  return !profile.erasedAt;
}

/** A profile counted as an active participant in organizer analytics (no registration check). */
export function networkingProfileActive(profile: Pick<NetworkingAccessProfile, "status" | "consent" | "withdrawnAt" | "erasedAt">): boolean {
  return profile.status === "ACTIVE" && profile.consent && !profile.withdrawnAt && !profile.erasedAt;
}

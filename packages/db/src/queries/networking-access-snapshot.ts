import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NetworkingConfigSchema, type NetworkingConfig } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { clients } from "../schema/users-clients";
import { forms } from "../schema/forms";
import { registrations } from "../schema/registrations";
import {
  networkingConfigs,
  networkingConnections,
  networkingProfiles,
  networkingSessions,
} from "../schema/networking";
import { networkingSecondFactors } from "../schema/networking-mfa";
import { networkingConsentPending } from "./networking-projection";
import { admittedProfile, mutuallyUnblocked, profileCounterpart } from "../policy/networking-eligibility";
import type { NetworkingPaymentStatuses } from "../policy/networking-eligibility";
import type { NetworkingAccessRegistration } from "../policy/networking-access";

/**
 * One-statement loaders for the facts the eligibility policy
 * (`policy/networking-access.ts`) decides on (plan 4.6). Each replaces a chain
 * of per-row reads (profile, registration, form, second factor, blocks,
 * connection) with one round trip on the caller's executor, so it is safe
 * inside a networking transaction.
 */

/** The registration columns eligibility and consent resolution read. */
const registrationFacts = {
  eventId: registrations.eventId,
  paymentStatus: registrations.paymentStatus,
  networkingOptIn: registrations.networkingOptIn,
  formData: registrations.formData,
};
export type NetworkingRegistrationFacts = {
  eventId: string;
  paymentStatus: string;
  networkingOptIn: boolean | null;
  formData: unknown;
};
type ProfileRow = typeof networkingProfiles.$inferSelect;

/** K1b: an unconsented profile whose registration leaves consent undecided. */
function consentPendingFor(
  profile: ProfileRow | null,
  registration: NetworkingRegistrationFacts | null,
  formSchema: unknown,
  config: NetworkingConfig,
) {
  if (!profile || !registration || profile.consent) return false;
  return networkingConsentPending({
    profile,
    optIn: registration.networkingOptIn,
    formSchema,
    formData: registration.formData,
    config,
  });
}

export type NetworkingParticipantSnapshot = {
  config: NetworkingConfig;
  client: { active: boolean; enabledModules: string[] | null } | null;
  /** The session `sessionId` names, if it is this profile's and not revoked (expiry is the caller's check). */
  session: typeof networkingSessions.$inferSelect | null;
  profile: ProfileRow | null;
  registration: NetworkingRegistrationFacts | null;
  secondFactorEnabled: boolean;
  consentPending: boolean;
};

/**
 * Everything participant access depends on, in one statement: the event's
 * networking config, the client's module state, the session, the profile, its
 * registration, its second factor and (unconsented only) its form. The event
 * row itself is not read: registration surges update it, and reading it in
 * every SERIALIZABLE participant write would turn them into retries. Null when
 * the event has no networking config (networking was never set up).
 */
export async function loadNetworkingParticipantSnapshot(
  input: { eventId: string; clientId: string; profileId: string; sessionId?: string },
  db: DbExecutor = getDb(),
): Promise<NetworkingParticipantSnapshot | null> {
  const [row] = await db
    .select({
      config: networkingConfigs.config,
      client: { active: clients.active, enabledModules: clients.enabledModules },
      session: networkingSessions,
      profile: networkingProfiles,
      registration: registrationFacts,
      formSchema: forms.schema,
      secondFactorEnabledAt: networkingSecondFactors.enabledAt,
    })
    .from(networkingConfigs)
    .leftJoin(clients, eq(clients.id, input.clientId))
    .leftJoin(networkingProfiles, and(eq(networkingProfiles.id, input.profileId), eq(networkingProfiles.eventId, networkingConfigs.eventId)))
    .leftJoin(registrations, eq(registrations.id, networkingProfiles.registrationId))
    .leftJoin(forms, and(sql`NOT ${networkingProfiles.consent}`, eq(forms.id, registrations.formId), eq(forms.eventId, networkingProfiles.eventId)))
    .leftJoin(networkingSecondFactors, eq(networkingSecondFactors.profileId, networkingProfiles.id))
    .leftJoin(networkingSessions, input.sessionId === undefined ? sql`false` : and(
      eq(networkingSessions.id, input.sessionId),
      eq(networkingSessions.eventId, networkingConfigs.eventId),
      eq(networkingSessions.profileId, input.profileId),
      sql`${networkingSessions.revokedAt} IS NULL`,
    ))
    .where(eq(networkingConfigs.eventId, input.eventId))
    .limit(1);
  if (!row) return null;
  const config = NetworkingConfigSchema.parse(row.config ?? {});
  const profile = row.profile ?? null;
  const registration = row.registration?.eventId ? row.registration : null;
  return {
    config,
    client: typeof row.client?.active === "boolean" ? row.client : null,
    session: row.session ?? null,
    profile,
    registration,
    secondFactorEnabled: !!row.secondFactorEnabledAt,
    consentPending: consentPendingFor(profile, registration, row.formSchema, config),
  };
}

export type NetworkingSignInCandidate = {
  profile: ProfileRow;
  registration: NetworkingRegistrationFacts | null;
  consentPending: boolean;
};

/**
 * The event's profiles for a sign-in address (exact, already normalized), with
 * their registrations and (unconsented only) forms, oldest first: a code goes
 * to, and a session is issued for, the first one with access.
 */
export async function loadNetworkingSignInCandidates(
  eventId: string,
  email: string,
  config: NetworkingConfig,
  db: DbExecutor = getDb(),
): Promise<NetworkingSignInCandidate[]> {
  const rows = await db
    .select({ profile: networkingProfiles, registration: registrationFacts, formSchema: forms.schema })
    .from(networkingProfiles)
    .leftJoin(registrations, eq(registrations.id, networkingProfiles.registrationId))
    .leftJoin(forms, and(sql`NOT ${networkingProfiles.consent}`, eq(forms.id, registrations.formId), eq(forms.eventId, networkingProfiles.eventId)))
    .where(and(eq(networkingProfiles.eventId, eventId), eq(networkingProfiles.email, email)))
    .orderBy(asc(networkingProfiles.createdAt), asc(networkingProfiles.id));
  return rows.map((row) => {
    const registration = row.registration?.eventId ? row.registration : null;
    return {
      profile: row.profile,
      registration,
      consentPending: consentPendingFor(row.profile, registration, row.formSchema, config),
    };
  });
}

const viewerProfiles = alias(networkingProfiles, "viewer_profile");
const viewerRegistrations = alias(registrations, "viewer_registration");
const targetProfiles = alias(networkingProfiles, "target_profile");
const targetRegistrations = alias(registrations, "target_registration");

export type NetworkingCounterpartSnapshot = {
  /** The viewer's current profile and registration (the viewer must still be eligible). */
  viewer: ProfileRow;
  viewerRegistration: NetworkingAccessRegistration | null;
  target: ProfileRow | null;
  targetRegistration: NetworkingAccessRegistration | null;
  /** A block in either direction. */
  blocked: boolean;
  connected: boolean;
};

/**
 * The viewer, the target, both registrations, any block between them and
 * their connection, in one statement. Null when the viewer's profile is gone.
 */
export async function loadNetworkingCounterpartSnapshot(
  input: { eventId: string; viewerId: string; targetId: string },
  db: DbExecutor = getDb(),
): Promise<NetworkingCounterpartSnapshot | null> {
  const [first, second] = input.viewerId < input.targetId
    ? [input.viewerId, input.targetId]
    : [input.targetId, input.viewerId];
  const [row] = await db
    .select({
      viewer: viewerProfiles,
      viewerRegistration: {
        eventId: viewerRegistrations.eventId,
        paymentStatus: viewerRegistrations.paymentStatus,
        networkingOptIn: viewerRegistrations.networkingOptIn,
      },
      target: targetProfiles,
      targetRegistration: {
        eventId: targetRegistrations.eventId,
        paymentStatus: targetRegistrations.paymentStatus,
        networkingOptIn: targetRegistrations.networkingOptIn,
      },
      blocked: sql<boolean>`NOT (${mutuallyUnblocked(input.eventId, input.viewerId, input.targetId)})`.mapWith(Boolean),
      connected: sql<boolean>`EXISTS (SELECT 1 FROM ${networkingConnections} WHERE ${networkingConnections.eventId}=${input.eventId}
        AND ${networkingConnections.profileAId}=${first} AND ${networkingConnections.profileBId}=${second})`.mapWith(Boolean),
    })
    .from(viewerProfiles)
    .leftJoin(viewerRegistrations, eq(viewerRegistrations.id, viewerProfiles.registrationId))
    .leftJoin(targetProfiles, and(eq(targetProfiles.id, input.targetId), eq(targetProfiles.eventId, viewerProfiles.eventId)))
    .leftJoin(targetRegistrations, eq(targetRegistrations.id, targetProfiles.registrationId))
    .where(and(eq(viewerProfiles.id, input.viewerId), eq(viewerProfiles.eventId, input.eventId)))
    .limit(1);
  if (!row) return null;
  return {
    viewer: row.viewer,
    viewerRegistration: row.viewerRegistration?.eventId ? row.viewerRegistration : null,
    target: row.target ?? null,
    targetRegistration: row.targetRegistration?.eventId ? row.targetRegistration : null,
    blocked: row.blocked === true,
    connected: row.connected === true,
  };
}

export type NetworkingProfileCounterparts = {
  /** The viewer's current profile and registration (the viewer must still be eligible). */
  viewer: { profile: ProfileRow; registration: NetworkingAccessRegistration | null } | null;
  /** Each target that exists, and whether the viewer may see it in `profile` mode. */
  targets: { profile: ProfileRow; visible: boolean }[];
};

/**
 * The batch twin of the counterpart snapshot for lists (plan 4.9): the viewer
 * and every target in one statement, each target's visibility decided by the
 * `profile` mode fragment (4.6), as `target()` decides it for one.
 */
export async function loadNetworkingProfileCounterparts(
  input: {
    eventId: string;
    viewerId: string;
    targetIds: readonly string[];
    statuses: NetworkingPaymentStatuses;
    /** `networkingDiscoveryEnabled(config)`. */
    discoveryEnabled: boolean;
  },
  db: DbExecutor = getDb(),
): Promise<NetworkingProfileCounterparts> {
  const p = networkingProfiles, r = registrations;
  const visible = profileCounterpart(p, r, input.statuses, { eventId: input.eventId, profileId: input.viewerId }, input.discoveryEnabled);
  const rows = await db
    .select({
      profile: p,
      registration: { eventId: r.eventId, paymentStatus: r.paymentStatus, networkingOptIn: r.networkingOptIn },
      visible: sql<boolean>`coalesce(${p.id}<>${input.viewerId} AND ${visible}, false)`.mapWith(Boolean),
    })
    .from(p)
    .leftJoin(r, eq(r.id, p.registrationId))
    .where(and(eq(p.eventId, input.eventId), inArray(p.id, [...new Set([input.viewerId, ...input.targetIds])])));
  const viewer = rows.find((row) => row.profile.id === input.viewerId);
  return {
    viewer: viewer
      ? { profile: viewer.profile, registration: viewer.registration?.eventId ? viewer.registration : null }
      : null,
    targets: rows
      .filter((row) => row.profile.id !== input.viewerId)
      .map((row) => ({ profile: row.profile, visible: row.visible === true })),
  };
}

/**
 * Admitted to the networking area (badge, organizer badge scan): eligible
 * with a confirmed meeting and, when an access item is required, holding it
 * while it is active. The same rule as check-in's networking admission; one
 * `SELECT EXISTS`.
 */
export async function networkingAreaAccess(
  input: { eventId: string; profileId: string; statuses: NetworkingPaymentStatuses; accessId?: string | null },
  db: DbExecutor = getDb(),
): Promise<boolean> {
  const p = networkingProfiles, r = registrations;
  const admitted = db
    .select({ one: sql`1` })
    .from(p)
    .innerJoin(r, eq(r.id, p.registrationId))
    .where(and(
      eq(p.id, input.profileId),
      eq(p.eventId, input.eventId),
      admittedProfile(p, r, input.statuses),
      input.accessId
        ? sql`EXISTS (SELECT 1 FROM event_access ea WHERE ea.id=${input.accessId} AND ea.event_id=${input.eventId} AND ea.active)
          AND ${input.accessId}::text=ANY(${r.accessTypeIds})`
        : undefined,
    ));
  const [row] = rowsOf<{ admitted: boolean }>(await db.execute(sql`SELECT EXISTS (${admitted}) AS admitted`));
  return row?.admitted === true;
}

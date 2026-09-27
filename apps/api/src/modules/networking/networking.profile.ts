import { BadRequestException } from "@nestjs/common";
import { ErrorCodes, networkingProfileOverrides, type LanguageCode, type NetworkingPersonalAnalytics } from "@app/contracts";
import { getDb, networkingStore, networkingTransaction, networkingIdentityEmail, syncNetworkingRegistration, withdrawNetworkingProfile } from "@app/db";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import { revokeParticipantAccess } from "./networking.revocation";
import { deleteNetworkingPhoto } from "./networking.uploads.service";
import { issueNetworkingBadge } from "./networking.security";
import type { NetworkingContext, NetworkingService } from "./networking.service";

// Participant profile reads and mutations with their after-commit effects.
// NetworkingService stays the facade and supplies current-participant policy.

export async function networkingPersonalAnalytics(networking: Pick<NetworkingService, "currentParticipant">, ctx: NetworkingContext): Promise<NetworkingPersonalAnalytics> {
  const store = networkingStore(getDb());
  ctx = await networking.currentParticipant(ctx, store);
  const profiles = await store.personalAnalyticsProfiles(ctx.event.clientId, networkingIdentityEmail(ctx.profile.email));
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

export async function updateNetworkingProfile(networking: Pick<NetworkingService, "currentParticipant">, ctx: NetworkingContext, input: Record<string, unknown>) {
  const { row, previousPhotoUrl, revoked, resynced } = await networkingTransaction(ctx.event.id, async (store, db) => {
    ctx = await networking.currentParticipant(ctx, store, { allowConsentPending: ctx.consentPending });
    const previousPhotoUrl = ctx.profile.photoUrl;
    // A consent-pending session may only record its consent choice (K1b).
    if (ctx.consentPending) input = input.consent === undefined ? {} : { consent: input.consent };
    const { consent, resetFields, ...fields } = input;
    const overrides = networkingProfileOverrides(ctx.profile.overrides);
    for (const key of (resetFields as string[] | undefined) ?? []) delete overrides[key];
    for (const field of ["company", "jobTitle", "sector"]) {
      if (field in fields) {
        if (typeof fields[field] !== "string" || !fields[field].trim())
          throw new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message: `${field} is required` });
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
      !ctx.config.languages.includes(fields.language as LanguageCode)
    )
      throw new BadRequestException({ code: ErrorCodes.NETWORKING_VALIDATION, message: "This language is not enabled for the event" });
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
    const revoked = consent === false;
    if (revoked) await revokeParticipantAccess(ctx.profile.id, ctx.event.id, db);
    const resynced = Array.isArray(resetFields) && resetFields.length > 0;
    if (resynced) {
      await syncNetworkingRegistration(ctx.profile.registrationId, db);
      return { row: (await store.one("profiles", { id: row.id, eventId: ctx.event.id }))!, previousPhotoUrl, revoked, resynced };
    }
    return { row, previousPhotoUrl, revoked, resynced };
  });
  // Declining consent revoked the sessions; a registration re-sync may have revoked them too.
  if (revoked || resynced)
    networkingIdentityCache.forgetProfile(ctx.profile.id);
  // Replaced, removed or reset photos are deleted after commit, and only from the participant's own prefix.
  if (row.photoUrl !== previousPhotoUrl) await deleteNetworkingPhoto(previousPhotoUrl, ctx.event.id, ctx.profile.id);
  return row;
}

export async function withdrawNetworkingParticipant(ctx: NetworkingContext) {
  // Keep durable erasure and its photo-deletion outbox row in the same transaction.
  await networkingTransaction(ctx.event.id, (_store, db) =>
    withdrawNetworkingProfile(db, { eventId: ctx.event.id, profileId: ctx.profile.id, slug: ctx.event.slug }));
  networkingIdentityCache.forgetProfile(ctx.profile.id);
  return { withdrawn: true };
}

export async function networkingParticipantBadge(networking: Pick<NetworkingService, "areaAccess">, ctx: NetworkingContext) {
  return {
    ...issueNetworkingBadge(ctx.profile.id, ctx.event.id),
    accessAllowed: await networking.areaAccess(ctx),
  };
}

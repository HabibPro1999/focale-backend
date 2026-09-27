import { networkingValidation } from "./networking.errors";
import { revokeParticipantAccess } from "./networking.revocation";

import { Injectable } from "@nestjs/common";
import { networkingStore, networkingTransaction, syncNetworkingRegistration } from "@app/db";
import { networkingProfileOverrides, type NetworkingPersonalAnalytics } from "@app/contracts";
import { networkingIdentityCache } from "../../core/networking-identity-cache";
import { deleteNetworkingPhoto } from "./networking.uploads.service";

import { cancelNetworkingParticipantMeetings, revokeNetworkingSessions } from "@app/db";
import { NetworkingService, type NetworkingContext } from "./networking.service";

@Injectable()
export class NetworkingProfileService {
  constructor(private readonly networking: NetworkingService) {}
  async personalAnalytics(ctx: NetworkingContext): Promise<NetworkingPersonalAnalytics> {
    const store = networkingStore();
    ctx = await this.networking.currentParticipant(ctx, store);
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
    const { row, previousPhotoUrl, revoked } = await networkingTransaction(ctx.event.id, async (store, db) => {
      ctx = await this.networking.currentParticipant(ctx, store, { allowConsentPending: ctx.consentPending });
      const previousPhotoUrl = ctx.profile.photoUrl;
      // A consent-pending session may only record its consent choice (K1b).
      if (ctx.consentPending) input = input.consent === undefined ? {} : { consent: input.consent };
      const { consent, resetFields, ...fields } = input;
      const overrides = networkingProfileOverrides(ctx.profile.overrides);
      for (const key of (resetFields as string[] | undefined) ?? []) delete overrides[key];
      for (const field of ["company", "jobTitle", "sector"]) {
        if (field in fields) {
          if (typeof fields[field] !== "string" || !fields[field].trim())
            throw networkingValidation(`${field} is required`);
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
        !ctx.config.languages.includes(fields.language as import("@app/contracts").LanguageCode)
      )
        throw networkingValidation("This language is not enabled for the event");
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
      if (consent === false) await revokeParticipantAccess(ctx.profile.id, ctx.event.id, db);
      const revoked = consent === false || (Array.isArray(resetFields) && resetFields.length > 0);
      if (Array.isArray(resetFields) && resetFields.length) {
        await syncNetworkingRegistration(ctx.profile.registrationId, db);
        return { row: (await store.one("profiles", { id: row.id, eventId: ctx.event.id }))!, previousPhotoUrl, revoked };
      }
      return { row, previousPhotoUrl, revoked };
    });
    // Declining consent revoked the sessions; a registration re-sync may have revoked them too.
    if (revoked)
      networkingIdentityCache.forgetProfile(ctx.profile.id);
    // Replaced, removed or reset photos are deleted after commit, and only from the participant's own prefix.
    if (row.photoUrl !== previousPhotoUrl) await deleteNetworkingPhoto(previousPhotoUrl, ctx.event.id, ctx.profile.id);
    return row;
  }
  async withdraw(ctx: NetworkingContext) {
    const photoUrl = await networkingTransaction(ctx.event.id, async (store, db) => {
      const current = await store.one("profiles", { eventId: ctx.event.id, id: ctx.profile.id });
      // The in-transaction row is authoritative; a null photo override stops sync restoring a form photo.
      await store.update(
        "profiles",
        { eventId: ctx.event.id, id: ctx.profile.id },
        {
          photoUrl: null,
          consent: false,
          visible: false,
          withdrawnAt: new Date(),
          overrides: { ...(current?.overrides ?? ctx.profile.overrides), photoUrl: null, consent: false },
        },
      );
      await revokeNetworkingSessions(ctx.profile.id, db);
      await store.remove("pushSubscriptions", {
        eventId: ctx.event.id,
        profileId: ctx.profile.id,
      });
      // One UPDATE … RETURNING over this participant's active meetings; notices never name the other side (K5).
      await cancelNetworkingParticipantMeetings(ctx.profile.id, ctx.event.id, db, { slug: ctx.event.slug });
      return current?.photoUrl;
    });
    networkingIdentityCache.forgetProfile(ctx.profile.id);
    await deleteNetworkingPhoto(photoUrl, ctx.event.id, ctx.profile.id);
    return { withdrawn: true };
  }
}

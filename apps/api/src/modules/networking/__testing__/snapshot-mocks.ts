import { NetworkingConfigSchema, type NetworkingConfig } from "@app/contracts";

/**
 * In-memory twins of the networking store's one-statement snapshot loaders
 * (4.6), for unit tests whose mock store keeps rows by entity. They read the
 * same rows the real statements join, through the mock's own `one`/`all`, so
 * the tests keep asserting behaviour rather than SQL.
 */
type Row = Record<string, unknown>;
type Lookup = {
  one: (kind: string, where: Row) => Promise<Row | null | undefined>;
  all: (kind: string, where: Row) => Promise<Row[]>;
};
type Dependencies = {
  /** The client module state (the real loader joins `clients`). */
  clientState?: (clientId: string) => unknown;
  /** `networkingConsentPending` from @app/db (pass the real one). */
  consentPending: (input: {
    profile: { consent: boolean; withdrawnAt: Date | null; overrides: unknown };
    optIn: boolean | null | undefined;
    formSchema: unknown;
    formData: unknown;
    config: NetworkingConfig;
  }) => boolean;
};

const facts = (registration: Row | null | undefined) =>
  registration
    ? {
        eventId: registration.eventId,
        paymentStatus: registration.paymentStatus,
        networkingOptIn: registration.networkingOptIn ?? null,
        formData: registration.formData ?? {},
      }
    : null;

export function networkingSnapshotMocks(store: Lookup, deps: Dependencies) {
  const pending = async (profile: Row | null | undefined, registration: Row | null | undefined, config: NetworkingConfig) => {
    if (!profile || !registration || profile.consent) return false;
    const form = await store.one("forms", { id: registration.formId, eventId: profile.eventId });
    return deps.consentPending({
      profile: { consent: !!profile.consent, withdrawnAt: (profile.withdrawnAt as Date | null | undefined) ?? null, overrides: profile.overrides ?? {} },
      optIn: registration.networkingOptIn as boolean | null | undefined,
      formSchema: form?.schema,
      formData: registration.formData ?? {},
      config,
    });
  };
  const registrationOf = (profile: Row | null | undefined) =>
    profile ? store.one("registrations", { id: profile.registrationId }) : null;
  return {
    async participantSnapshot(input: { eventId: string; clientId: string; profileId: string; sessionId?: string }) {
      const configRow = await store.one("configs", { eventId: input.eventId });
      const config = NetworkingConfigSchema.parse(configRow?.config ?? {});
      const client = deps.clientState ? await deps.clientState(input.clientId) : { active: true, enabledModules: ["networking", "registrations", "emails"] };
      const profile = (await store.one("profiles", { id: input.profileId, eventId: input.eventId })) ?? null;
      const registration = await registrationOf(profile);
      const session = input.sessionId
        ? ((await store.one("sessions", { id: input.sessionId, eventId: input.eventId, profileId: input.profileId, revokedAt: null })) ?? null)
        : null;
      const factor = profile ? await store.one("secondFactors", { profileId: profile.id }) : null;
      return {
        config,
        client: client ?? null,
        session,
        profile,
        registration: facts(registration),
        secondFactorEnabled: !!factor?.enabledAt,
        consentPending: await pending(profile, registration, config),
      };
    },
    async signInCandidates(eventId: string, email: string, config: NetworkingConfig) {
      const profiles = (await store.all("profiles", { eventId, email }))
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
      const result = [];
      for (const profile of profiles) {
        const registration = await registrationOf(profile);
        result.push({ profile, registration: facts(registration), consentPending: await pending(profile, registration, config) });
      }
      return result;
    },
    async counterpartSnapshot(input: { eventId: string; viewerId: string; targetId: string }) {
      const viewer = await store.one("profiles", { id: input.viewerId, eventId: input.eventId });
      if (!viewer) return null;
      const target = (await store.one("profiles", { id: input.targetId, eventId: input.eventId })) ?? null;
      const [profileAId, profileBId] = input.viewerId < input.targetId ? [input.viewerId, input.targetId] : [input.targetId, input.viewerId];
      const blocked = !!(await store.one("blocks", { eventId: input.eventId, profileId: input.viewerId, targetId: input.targetId }))
        || !!(await store.one("blocks", { eventId: input.eventId, profileId: input.targetId, targetId: input.viewerId }));
      return {
        viewer,
        viewerRegistration: facts(await registrationOf(viewer)),
        target,
        targetRegistration: facts(await registrationOf(target)),
        blocked,
        connected: !!(await store.one("connections", { eventId: input.eventId, profileAId, profileBId })),
      };
    },
  };
}

import type { NetworkingAccess } from "../policy/networking-access";

/**
 * The networking eligibility fixture matrix (plan 4.6). Each row is one
 * counterpart ("target") seen by one eligible viewer in one event, described
 * as changes to an eligible baseline, with the answer every surface must give.
 * The pure policy is checked against it in unit tests; the DB tier builds the
 * same rows in a real database and runs every query and service surface
 * against it on both engines.
 *
 * Baseline target: ACTIVE, consented, visible, complete profile; a PAID
 * registration in the same event that opted in; not connected, not blocked,
 * not swiped; a confirmed meeting with the viewer.
 *
 * Surfaces without a column of their own answer from these: producers and
 * deliveries addressed to the target follow `access` (a sign-in code also
 * reaches CONSENT_PENDING, everything else needs CONSENTED); anything that
 * names the target to the viewer (reminders, meeting and connection
 * notices, the contact in a rendered message) follows `peer`.
 */
export type NetworkingEligibilityRow = {
  name: string;
  profile?: {
    status?: "PENDING" | "ACTIVE" | "SUSPENDED" | "EXCLUDED";
    consent?: boolean;
    /** The participant's explicit PWA choice (overrides.consent). */
    choice?: boolean;
    visible?: boolean;
    company?: string;
    withdrawn?: boolean;
    erased?: boolean;
    /** The viewer's address in another case: two profiles of one person. */
    sameEmailAsViewer?: boolean;
  };
  registration?: {
    paymentStatus?: "PAID" | "PENDING";
    networkingOptIn?: boolean | null;
    /** The registration row belongs to another event. */
    otherEvent?: boolean;
  };
  relation?: {
    /** Viewer and target are connected, and the target sent one unread message. */
    connected?: boolean;
    /** The viewer liked the target. */
    liked?: boolean;
    viewerBlocked?: boolean;
    blockedViewer?: boolean;
    /** Default true: a confirmed meeting with the viewer. */
    confirmedMeeting?: boolean;
  };
  expect: {
    /** The target's own access (`networkingParticipantAccess`). */
    access: NetworkingAccess | null;
    /** Counterpart `profile` mode: a profile opened directly. */
    profile: boolean;
    /** Counterpart `discover` mode: discovery lists, search, facets, swipes. */
    discover: boolean;
    /** `discover` and never swiped or connected: recommendations, `excludeInteracted`. */
    fresh: boolean;
    /** Counterpart `peer` mode: listed in the viewer's connections when connected. */
    peer: boolean;
    /** Counterpart `blocklist` mode: shown on the viewer's block list. */
    blocklist: boolean;
    /** Admitted to the networking area (eligible with a confirmed meeting). */
    admitted: boolean;
    /** Shown in organizer lists, exports and counts (`networkingProfileListed`). */
    listed: boolean;
    /** Counted active in organizer analytics (`networkingProfileActive`). */
    active: boolean;
    /** Embedded for recommendations (`networkingProfileEmbeddable`): eligible and visible. */
    embedded: boolean;
  };
};

const none = { access: null, profile: false, discover: false, fresh: false, peer: false, blocklist: false, admitted: false, embedded: false } as const;
const eligible = { access: "CONSENTED", profile: true, discover: true, fresh: true, peer: true, blocklist: true, admitted: true, listed: true, active: true, embedded: true } as const;

export const NETWORKING_ELIGIBILITY_MATRIX: readonly NetworkingEligibilityRow[] = [
  { name: "eligible", expect: eligible },
  {
    name: "eligible, connected and liked",
    relation: { connected: true, liked: true },
    expect: { ...eligible, fresh: false },
  },
  {
    name: "eligible without a confirmed meeting",
    relation: { confirmedMeeting: false },
    expect: { ...eligible, admitted: false },
  },
  { name: "pending approval", profile: { status: "PENDING" }, relation: { connected: true }, expect: { ...none, listed: true, active: false } },
  { name: "suspended", profile: { status: "SUSPENDED" }, relation: { connected: true }, expect: { ...none, listed: true, active: false } },
  { name: "excluded", profile: { status: "EXCLUDED" }, relation: { connected: true }, expect: { ...none, listed: true, active: false } },
  {
    name: "undecided consent",
    profile: { consent: false },
    registration: { networkingOptIn: null },
    relation: { connected: true },
    expect: { ...none, access: "CONSENT_PENDING", listed: true, active: false },
  },
  {
    name: "declined consent",
    profile: { consent: false, choice: false },
    registration: { networkingOptIn: null },
    relation: { connected: true },
    expect: { ...none, listed: true, active: false },
  },
  {
    // Adversarial: only withdrawn_at marks it (real withdrawals also scrub the row).
    name: "withdrawn",
    profile: { withdrawn: true },
    relation: { connected: true },
    expect: { ...none, listed: true, active: false },
  },
  {
    // Adversarial: only erased_at marks it.
    name: "erased (flag only)",
    profile: { erased: true },
    relation: { connected: true },
    expect: { ...none, listed: false, active: false },
  },
  {
    name: "erased tombstone",
    profile: { withdrawn: true, erased: true, status: "EXCLUDED", consent: false, visible: false, company: "" },
    relation: { connected: true },
    expect: { ...none, listed: false, active: false },
  },
  {
    name: "registration opted out",
    registration: { networkingOptIn: false },
    relation: { connected: true },
    expect: { ...none, listed: true, active: true },
  },
  {
    name: "payment not eligible",
    registration: { paymentStatus: "PENDING" },
    relation: { connected: true },
    expect: { ...none, listed: true, active: true },
  },
  {
    name: "registration of another event",
    registration: { otherEvent: true },
    relation: { connected: true },
    expect: { ...none, listed: true, active: true },
  },
  {
    name: "hidden",
    profile: { visible: false },
    expect: { ...eligible, profile: false, discover: false, fresh: false, blocklist: false, embedded: false },
  },
  {
    name: "hidden, connected",
    profile: { visible: false },
    relation: { connected: true },
    expect: { ...eligible, discover: false, fresh: false, embedded: false },
  },
  {
    name: "incomplete profile",
    profile: { company: " " },
    expect: { ...eligible, profile: false, discover: false, fresh: false, blocklist: false },
  },
  {
    name: "blocked by the viewer",
    relation: { connected: true, viewerBlocked: true },
    expect: { ...eligible, profile: false, discover: false, fresh: false, peer: false },
  },
  {
    name: "blocks the viewer",
    relation: { connected: true, blockedViewer: true },
    expect: { ...eligible, profile: false, discover: false, fresh: false, peer: false },
  },
  {
    name: "same person as the viewer",
    profile: { sameEmailAsViewer: true },
    expect: { ...eligible, profile: false, discover: false, fresh: false, peer: false, blocklist: false },
  },
];

/** The facts the pure policy reads for one matrix row (the DB tier builds the same rows). */
export function networkingEligibilityRowFacts(
  row: NetworkingEligibilityRow,
  ids: { eventId: string; otherEventId: string; targetId: string; viewer: { id: string; email: string } },
) {
  const withdrawnAt = row.profile?.withdrawn ? new Date("2026-01-01T00:00:00.000Z") : null;
  const erasedAt = row.profile?.erased ? new Date("2026-02-01T00:00:00.000Z") : null;
  const profile = {
    id: ids.targetId,
    eventId: ids.eventId,
    email: row.profile?.sameEmailAsViewer ? ids.viewer.email.toUpperCase() : `${ids.targetId}@example.invalid`,
    status: row.profile?.status ?? "ACTIVE",
    consent: row.profile?.consent ?? true,
    visible: row.profile?.visible ?? true,
    withdrawnAt,
    erasedAt,
    firstName: "Target",
    lastName: row.name,
    company: row.profile?.company ?? "Company",
    jobTitle: "Director",
    sector: `Sector ${row.name}`,
    overrides: row.profile?.choice === undefined ? {} : { consent: row.profile.choice },
  };
  const registration = {
    eventId: row.registration?.otherEvent ? ids.otherEventId : ids.eventId,
    paymentStatus: row.registration?.paymentStatus ?? "PAID",
    networkingOptIn: row.registration?.networkingOptIn === undefined ? true : row.registration.networkingOptIn,
  };
  return {
    profile,
    registration,
    /** Undecided when neither the registration nor the participant chose (no mapped answer). */
    consentPending: !profile.consent && !withdrawnAt && registration.networkingOptIn == null && row.profile?.choice === undefined,
    blocked: !!row.relation?.viewerBlocked || !!row.relation?.blockedViewer,
    connected: !!row.relation?.connected,
    liked: !!row.relation?.liked,
    confirmedMeeting: row.relation?.confirmedMeeting !== false,
  };
}

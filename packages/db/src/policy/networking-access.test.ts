import { describe, expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  networkingCounterpartVisible,
  networkingDistinctIdentity,
  networkingEventAvailable,
  networkingIdentityEmail,
  networkingParticipantAccess,
  networkingPaymentEligible,
  networkingParticipantEligible,
  networkingProfileActive,
  networkingProfileEmbeddable,
  networkingProfileListed,
  networkingWindow,
  type NetworkingCounterpartMode,
} from "./networking-access";
import {
  NETWORKING_ELIGIBILITY_MATRIX,
  networkingEligibilityRowFacts,
} from "../testing/networking-eligibility-matrix";

const config = NetworkingConfigSchema.parse({ enabled: true, eligiblePaymentStatuses: ["PAID"] });
const viewer = { id: "viewer", email: "viewer@example.invalid" };
const ids = { eventId: "event", otherEventId: "other-event", viewer };
const factsOf = (row: (typeof NETWORKING_ELIGIBILITY_MATRIX)[number], index: number) =>
  networkingEligibilityRowFacts(row, { ...ids, targetId: `target-${String(index).padStart(2, "0")}` });
const counterpart = (facts: ReturnType<typeof factsOf>) => ({
  viewer,
  target: facts.profile,
  targetRegistration: facts.registration,
  blocked: facts.blocked,
  connected: facts.connected,
});

describe("networking eligibility matrix (pure policy, 4.6)", () => {
  it("names every row once", () => {
    const names = NETWORKING_ELIGIBILITY_MATRIX.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it.each(NETWORKING_ELIGIBILITY_MATRIX.map((row, index) => [row.name, row, index] as const))("%s", (_name, row, index) => {
    const facts = factsOf(row, index);
    const visible = (mode: NetworkingCounterpartMode) => networkingCounterpartVisible(counterpart(facts), config, mode);
    const eligible = networkingParticipantEligible(facts, config);
    expect({
      access: networkingParticipantAccess(facts, config),
      profile: visible("profile"),
      discover: visible("discover"),
      fresh: visible("discover") && !facts.liked && !facts.connected,
      peer: visible("peer"),
      blocklist: visible("blocklist"),
      admitted: eligible && facts.confirmedMeeting,
      listed: networkingProfileListed(facts.profile),
      active: networkingProfileActive(facts.profile),
      embedded: networkingProfileEmbeddable(facts, config),
    }).toEqual(row.expect);
  });
  it("covers withdrawn and erased profiles", () => {
    const flagged = NETWORKING_ELIGIBILITY_MATRIX.filter((row) => row.profile?.withdrawn || row.profile?.erased);
    expect(flagged.map((row) => row.name)).toEqual(["withdrawn", "erased (flag only)", "erased tombstone"]);
    for (const row of flagged) {
      expect(row.expect).toMatchObject({ access: null, profile: false, discover: false, peer: false, blocklist: false, admitted: false, active: false, embedded: false });
    }
  });
  it("with discovery off, a counterpart is only seen through a connection", () => {
    const closed = { ...config, swipeEnabled: false, searchEnabled: false };
    NETWORKING_ELIGIBILITY_MATRIX.forEach((row, index) => {
      const facts = factsOf(row, index);
      expect(networkingCounterpartVisible(counterpart(facts), closed, "discover")).toBe(false);
      expect(networkingCounterpartVisible(counterpart(facts), closed, "profile")).toBe(row.expect.peer && facts.connected);
    });
  });
  it("refuses a consent-pending participant everything but the consent flow", () => {
    const row = NETWORKING_ELIGIBILITY_MATRIX.find((candidate) => candidate.expect.access === "CONSENT_PENDING")!;
    const facts = factsOf(row, 0);
    expect(networkingParticipantAccess(facts, config, { allowConsentPending: false })).toBeNull();
    expect(networkingParticipantEligible(facts, config)).toBe(false);
    expect(networkingParticipantAccess({ ...facts, consentPending: false }, config)).toBeNull();
  });
  it("reads payment eligibility and identity the same way everywhere", () => {
    expect(networkingPaymentEligible({ paymentStatus: "PAID" }, config)).toBe(true);
    expect(networkingPaymentEligible({ paymentStatus: "PENDING" }, config)).toBe(false);
    expect(networkingPaymentEligible({ paymentStatus: "PAID" }, { eligiblePaymentStatuses: [] })).toBe(false);
    expect(networkingIdentityEmail("  Ann@Example.TEST ")).toBe("ann@example.test");
    expect(networkingDistinctIdentity({ id: "a", email: "ann@example.test" }, { id: "b", email: " ANN@example.test" })).toBe(false);
  });
  it("needs both the profile and its registration", () => {
    const facts = factsOf(NETWORKING_ELIGIBILITY_MATRIX[0], 0);
    expect(networkingParticipantAccess({ profile: facts.profile, registration: null }, config)).toBeNull();
    expect(networkingParticipantAccess({ profile: null, registration: facts.registration }, config)).toBeNull();
  });
});

describe("networking gate and window", () => {
  const event = { status: "OPEN", endDate: new Date("2031-01-10T00:00:00Z") };
  const client = { active: true, enabledModules: ["networking", "registrations", "emails"] };
  it("requires the config, a live event and every client module", () => {
    expect(networkingEventAvailable({ event, client, config })).toBe(true);
    expect(networkingEventAvailable({ event, client, config: { ...config, enabled: false } })).toBe(false);
    expect(networkingEventAvailable({ event: { ...event, status: "ARCHIVED" }, client, config })).toBe(false);
    expect(networkingEventAvailable({ event: null, client, config })).toBe(false);
    expect(networkingEventAvailable({ event, client: { ...client, active: false }, config })).toBe(false);
    expect(networkingEventAvailable({ event, client: null, config })).toBe(false);
    for (const module of client.enabledModules)
      expect(networkingEventAvailable({ event, client: { ...client, enabledModules: client.enabledModules.filter((m) => m !== module) }, config })).toBe(false);
    expect(networkingEventAvailable({ event, client: { ...client, enabledModules: null }, config })).toBe(false);
  });
  it("places now in the opening window, then the retention period", () => {
    const at = (iso: string) => Date.parse(iso);
    const window = { ...config, opensAt: "2031-01-01T00:00:00Z", closesAt: "2031-01-09T00:00:00Z", retentionDays: 30 };
    expect(networkingWindow(window, event, at("2030-12-31T23:59:59Z"))).toBe("NOT_YET_OPEN");
    expect(networkingWindow(window, event, at("2031-01-05T00:00:00Z"))).toBe("OPEN");
    expect(networkingWindow(window, event, at("2031-01-09T00:00:00Z"))).toBe("CLOSED");
    expect(networkingWindow(window, event, at("2031-02-10T00:00:01Z"))).toBe("RETENTION_ENDED");
    expect(networkingWindow({ ...config, retentionDays: 30 }, event, at("2031-02-09T00:00:00Z"))).toBe("OPEN");
  });
});

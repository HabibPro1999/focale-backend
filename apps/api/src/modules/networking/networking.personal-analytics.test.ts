import { describe, expect, it, vi } from "vitest";
import { NetworkingProfileUpdateSchema } from "@app/contracts";
const fixture = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, any>>> }));
vi.mock("@app/db", () => ({ networkingStore: () => ({ all: async (kind: string, filter: Record<string, string>) => (fixture.rows[kind] ?? []).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)) }) }));
import { NetworkingService, type NetworkingContext } from "./networking.service";
const ctx = { event: { id: "current", clientId: "owner" }, profile: { id: "a", email: "OWN@example.test" } } as NetworkingContext;
describe("private cross-event ROI", () => {
  it("aggregates only the verified email in the same client and deduplicates duplicate profile connections", async () => {
    const stamp = new Date("2030-01-01T00:00:00Z");
    fixture.rows = {
      events: ["current", "prior", "other-email", "foreign"].map(id => ({ id, name: id, clientId: id === "foreign" ? "foreign-client" : "owner", startDate: stamp, endDate: stamp })),
      profiles: [
        { id: "a", eventId: "current", email: "own@example.test" },
        { id: "duplicate", eventId: "current", email: " Own@Example.test " },
        { id: "b", eventId: "current", email: "contact@example.test" },
        { id: "old", eventId: "prior", email: "own@example.test" },
        { id: "unrelated", eventId: "other-email", email: "different@example.test" },
        { id: "foreign", eventId: "foreign", email: "own@example.test" },
      ],
      connections: [{ profileAId: "a", profileBId: "b" }, { profileAId: "duplicate", profileBId: "b" }, { profileAId: "a", profileBId: "duplicate" }].map(row => ({ ...row, eventId: "current" })),
      messages: ["a", "duplicate", "b"].map(senderId => ({ senderId, eventId: "current" })),
      audit: ["a", "duplicate", "b"].map(targetId => ({ targetId, action: "PROFILE_VIEW", eventId: "current" })),
      meetings: ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "PENDING"].map(status => ({ requesterId: "a", recipientId: "duplicate", status, eventId: "current" })),
    };
    const service = new NetworkingService();
    const eligibility = vi.spyOn(service, "currentParticipant").mockResolvedValue(ctx);
    const result = await service.personalAnalytics(ctx);
    expect(eligibility).toHaveBeenCalledWith(ctx, expect.anything());
    expect(result.events.map(event => event.eventId)).toEqual(["current", "prior"]);
    expect(result.events[0]).toMatchObject({ profileViews: 2, matches: 1, sentMessages: 2, plannedMeetings: 3, completedMeetings: 1 });
    expect(result.events[1]).toMatchObject({ profileViews: 0, matches: 0, sentMessages: 0, plannedMeetings: 0, completedMeetings: 0 });
    expect(JSON.stringify(result)).not.toContain("@example.test");
    eligibility.mockRejectedValue(new Error("Session revoked"));
    await expect(service.personalAnalytics(ctx)).rejects.toThrow("Session revoked");
  });
  it("rejects blank supplied professional fields while allowing incomplete onboarding to change unrelated preferences", () => {
    for (const field of ["company", "jobTitle", "sector"]) {
      expect(NetworkingProfileUpdateSchema.safeParse({ [field]: "   " }).success).toBe(false);
      expect(NetworkingProfileUpdateSchema.parse({ [field]: "  Professional  " })).toEqual({ [field]: "Professional" });
    }
    expect(NetworkingProfileUpdateSchema.safeParse({ language: "en" }).success).toBe(true);
  });
});

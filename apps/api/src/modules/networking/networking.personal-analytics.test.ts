import { describe, expect, it, vi } from "vitest";
import { NetworkingProfileUpdateSchema } from "@app/contracts";
const fixture = vi.hoisted(() => ({ rows: {} as Record<string, Array<Record<string, any>>> }));
const queries = vi.hoisted(() => ({ profiles: vi.fn(), rows: vi.fn(), all: vi.fn() }));
vi.mock("@app/db", () => ({ networkingStore: () => ({
  all: queries.all,
  personalAnalyticsProfiles: queries.profiles,
  personalAnalyticsRows: queries.rows,
}) }));
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
    queries.profiles.mockImplementation(async (clientId, email) => fixture.rows.profiles.flatMap(profile => {
      const event = fixture.rows.events.find(event => event.id === profile.eventId && event.clientId === clientId);
      return event && profile.email.trim().toLowerCase() === email ? [{ ...event, ...profile }] : [];
    }));
    queries.rows.mockImplementation(async (eventId, ids: string[]) => ({
      audit: fixture.rows.audit.filter(row => row.eventId === eventId && ids.includes(row.targetId)),
      messages: fixture.rows.messages.filter(row => row.eventId === eventId && ids.includes(row.senderId)),
      meetings: fixture.rows.meetings.filter(row => row.eventId === eventId && (ids.includes(row.requesterId) || ids.includes(row.recipientId))),
      connections: fixture.rows.connections.filter(row => row.eventId === eventId && (ids.includes(row.profileAId) || ids.includes(row.profileBId))).map(row => ({ ...row,
        email: fixture.rows.profiles.find(p => p.id === (ids.includes(row.profileAId) ? row.profileBId : row.profileAId))!.email,
      })),
    }));
    const service = new NetworkingService();
    const eligibility = vi.spyOn(service, "currentParticipant").mockResolvedValue(ctx);
    const result = await service.personalAnalytics(ctx);
    expect(queries.all).not.toHaveBeenCalled();
    expect(queries.profiles).toHaveBeenCalledWith("owner", "own@example.test");
    expect(queries.rows.mock.calls).toEqual([["current", ["a", "duplicate"]], ["prior", ["old"]]]);
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

import { describe, expect, it, vi } from "vitest";
import { NetworkingProfileUpdateSchema } from "@app/contracts";
const queries = vi.hoisted(() => ({ profiles: vi.fn(), rows: vi.fn(), all: vi.fn() }));
vi.mock("@app/db", () => ({ networkingStore: () => ({
  all: queries.all,
  personalAnalyticsProfiles: queries.profiles,
  personalAnalyticsCounts: queries.rows,
}) }));
import { NetworkingService, type NetworkingContext } from "./networking.service";
const ctx = { event: { id: "current", clientId: "owner" }, profile: { id: "a", email: "OWN@example.test" } } as NetworkingContext;
describe("private cross-event ROI", () => {
  it("aggregates only the verified email in the same client, one count query set per event", async () => {
    const stamp = new Date("2030-01-01T00:00:00Z");
    const later = new Date("2031-01-01T00:00:00Z");
    queries.profiles.mockResolvedValue([
      { id: "a", eventId: "current", name: "Current", startDate: stamp, endDate: stamp },
      { id: "duplicate", eventId: "current", name: "Current", startDate: stamp, endDate: stamp },
      { id: "old", eventId: "prior", name: "Prior", startDate: later, endDate: later },
    ]);
    const counts = { profileViews: 2, matches: 1, sentMessages: 2, plannedMeetings: 3, completedMeetings: 1 };
    queries.rows.mockImplementation(async (eventId: string) => eventId === "current" ? counts
      : { profileViews: 0, matches: 0, sentMessages: 0, plannedMeetings: 0, completedMeetings: 0 });
    const service = new NetworkingService();
    const eligibility = vi.spyOn(service, "currentParticipant").mockResolvedValue(ctx);
    const result = await service.personalAnalytics(ctx);
    expect(queries.all).not.toHaveBeenCalled();
    expect(queries.profiles).toHaveBeenCalledWith("owner", "own@example.test");
    expect(queries.rows.mock.calls).toEqual([["current", ["a", "duplicate"]], ["prior", ["old"]]]);
    expect(eligibility).toHaveBeenCalledWith(ctx, expect.anything());
    expect(result).toEqual({ currentEventId: "current", events: [
      { eventId: "prior", eventName: "Prior", startsAt: later.toISOString(), endsAt: later.toISOString(), profileViews: 0, matches: 0, sentMessages: 0, plannedMeetings: 0, completedMeetings: 0 },
      { eventId: "current", eventName: "Current", startsAt: stamp.toISOString(), endsAt: stamp.toISOString(), ...counts },
    ] });
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

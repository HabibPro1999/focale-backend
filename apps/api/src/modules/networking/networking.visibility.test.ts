import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingRow } from "@app/db";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  one: vi.fn(),
  all: vi.fn(),
  summaries: vi.fn(),
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  networkingStore: () => db,
  listNetworkingConnectionSummaries: db.summaries,
}));

import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingSocialService } from "./networking.social.service";

const now = new Date("2099-01-01T09:00:00Z");
function profile(id: string, firstName: string): NetworkingRow<"profiles"> {
  return {
    id, eventId: "event", registrationId: `registration-${id}`, email: `${id}@example.test`,
    firstName, lastName: "Participant", company: "Company", jobTitle: "Engineer", sector: "Software",
    bio: "", city: "", country: "", website: null, photoUrl: null, interests: [], offers: "", seeks: "",
    status: "ACTIVE", visible: true, meetingsEnabled: true, emailPreference: "IMMEDIATE", language: "en",
    consent: true, availabilitySet: false, consentAt: now, lastActiveAt: now, withdrawnAt: null,
    featured: true, standTableId: null, overrides: {}, createdAt: now, updatedAt: now,
  };
}
const viewer = profile("a", "Alice");
const target = profile("b", "Bob");
const ctx = {
  event: { id: "event", slug: "demo" },
  config: NetworkingConfigSchema.parse({ enabled: true }),
  profile: viewer,
  session: { id: "session" },
} as NetworkingContext;
const meeting: NetworkingRow<"meetings"> = {
  id: "meeting", eventId: "event", requesterId: viewer.id, recipientId: target.id,
  startsAt: now, endsAt: new Date(+now + 1_800_000), tableId: null, status: "CONFIRMED",
  message: "Meeting note", cancellationNote: "", proposedStartsAt: null, proposalBy: null,
  expiresAt: now, revision: 1, requesterCheckedInAt: null, recipientCheckedInAt: null,
  createdAt: now, updatedAt: now,
};
const connection = {
  id: "connection", eventId: "event", profileAId: viewer.id, profileBId: target.id, createdAt: now,
};
const summary = { id: connection.id, createdAt: now, profile: target, lastMessage: null, unreadCount: 0 };
const networking = new NetworkingService();
const meetings = new NetworkingMeetingsService(networking);
const social = new NetworkingSocialService(networking);

beforeEach(() => {
  vi.resetAllMocks();
  db.rows = {
    profiles: [{ ...viewer }, { ...target }],
    registrations: [viewer, target].map(({ registrationId }) => ({
      id: registrationId, eventId: "event", paymentStatus: "PAID", networkingOptIn: true,
    })),
    connections: [{ ...connection }],
    interests: [{ id: "interest", eventId: "event", profileId: target.id, targetId: viewer.id, action: "LIKE", createdAt: now }],
    blocks: [],
  };
  // Only the query boundary is mocked: target(), eligibility, and the three callers all execute.
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  db.one.mockImplementation(async (kind: string, where: Record<string, unknown>) =>
    (db.rows[kind] ?? []).find((row) => matches(row, where)) ?? null);
  db.all.mockImplementation(async (kind: string, where: Record<string, unknown>) =>
    (db.rows[kind] ?? []).filter((row) => matches(row, where)));
  db.summaries.mockResolvedValue([summary]);
});

describe("counterpart visibility with symmetric blocks", () => {
  describe.each([
    { label: "viewer blocks target", profileId: viewer.id, targetId: target.id },
    { label: "target blocks viewer", profileId: target.id, targetId: viewer.id },
  ])("$label", ({ profileId, targetId }) => {
    beforeEach(() => {
      db.rows.blocks = [{ id: "block", eventId: "event", profileId, targetId, createdAt: now }];
    });

    it.each(["requester", "recipient"] as const)("hides the counterpart when the viewer is the meeting %s", async (role) => {
      const row = role === "requester" ? meeting : { ...meeting, requesterId: target.id, recipientId: viewer.id };
      const result = await meetings.hydrate(row, undefined, false, ctx);

      expect(result).toMatchObject({ id: meeting.id, status: "CONFIRMED", message: "Meeting note" });
      expect(result[role]).toMatchObject({ id: viewer.id, firstName: "Alice" });
      expect(result[role === "requester" ? "recipient" : "requester"]).toBeNull();
    });

    it("omits the incoming interest and its profile", async () => {
      expect(await social.incoming(ctx)).toEqual({ items: [], total: 0 });
    });

    it("returns no connection even when a summary is available", async () => {
      expect(await social.connectionWith(ctx, target.id)).toBeNull();
      expect(db.summaries).not.toHaveBeenCalled();
    });
  });

  it("hydrates both public profiles when neither participant has blocked the other", async () => {
    const result = await meetings.hydrate(meeting, undefined, false, ctx);
    expect(result.requester).toMatchObject({ id: viewer.id, firstName: "Alice" });
    expect(result.recipient).toMatchObject({ id: target.id, firstName: "Bob" });
    expect(result.recipient).not.toHaveProperty("email");
    expect(result.recipient).not.toHaveProperty("registrationId");
  });

  it("includes the unblocked incoming interest with a public profile", async () => {
    const result = await social.incoming(ctx);
    expect(result).toMatchObject({ items: [{ id: "interest", createdAt: now, profile: { id: target.id } }], total: 1 });
    expect(result.items[0].profile).not.toHaveProperty("email");
  });

  it("returns the unblocked connection's public summary", async () => {
    const result = await social.connectionWith(ctx, target.id);
    expect(result).toMatchObject({ id: connection.id, createdAt: now, profile: { id: target.id }, lastMessage: null, unreadCount: 0 });
    expect(result?.profile).not.toHaveProperty("email");
    expect(db.summaries).toHaveBeenCalledWith("event", viewer.id, ctx.config.eligiblePaymentStatuses, undefined, { connectionId: connection.id });
  });
});

describe("connectionWith unavailable results beyond target visibility", () => {
  it("returns null when the pair has no connection", async () => {
    db.rows.connections = [];
    expect(await social.connectionWith(ctx, target.id)).toBeNull();
    expect(db.summaries).not.toHaveBeenCalled();
  });

  it("returns null if the connection disappears after the pair lookup", async () => {
    db.one.mockResolvedValueOnce(connection).mockResolvedValueOnce(null);
    expect(await social.connectionWith(ctx, target.id)).toBeNull();
    expect(db.summaries).not.toHaveBeenCalled();
  });

  it("returns null if the visibility-filtered summary disappears after target validation", async () => {
    db.summaries.mockResolvedValue([]);
    expect(await social.connectionWith(ctx, target.id)).toBeNull();
    expect(db.summaries).toHaveBeenCalledOnce();
  });
});

describe("non-404 policy errors remain errors", () => {
  it.each([
    ["meeting hydration", () => meetings.hydrate(meeting, undefined, false, ctx)],
    ["incoming interests", () => social.incoming(ctx)],
    ["connectionWith", () => social.connectionWith(ctx, target.id)],
  ] as const)("%s propagates the re-read viewer's lost eligibility", async (_label, read) => {
    db.rows.registrations[0].paymentStatus = "PENDING";
    await expect(read()).rejects.toMatchObject({
      status: 403,
      response: { code: "NETWORKING_NOT_ELIGIBLE", message: "Networking participation is no longer eligible" },
    });
  });
});

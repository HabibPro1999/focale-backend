import { beforeEach, expect, it, vi } from "vitest";
// A real Drizzle builder over a recording client: the statements the context issues.
const recorded = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock("../client", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const client = {
    query: async (config: { text: string }) => {
      recorded.queries.push(config.text);
      return { rows: [], rowCount: 0, fields: [] };
    },
  };
  const db = drizzle(client as never, { casing: "snake_case" });
  return { getDb: () => db };
});
import { networkingDeliveryContext, networkingDigestContexts, type NetworkingDeliveryRow } from "./networking-delivery";

const row = (type: string, payload: Record<string, unknown>) =>
  ({ id: "delivery", eventId: "event", profileId: "profile", type, payload }) as unknown as NetworkingDeliveryRow;
const squash = (text: string) => text.replace(/\s+/g, " ");
beforeEach(() => {
  recorded.queries.length = 0;
});

it("loads a delivery's whole context in one statement (plus push subscriptions when asked)", async () => {
  const context = await networkingDeliveryContext(
    row("MESSAGE", { connectionId: "connection", messageId: "message" }),
    { subscriptions: false },
  );
  expect(recorded.queries).toHaveLength(1);
  const sql = squash(recorded.queries[0]!);
  for (const joined of [
    'left join "clients"',
    'left join "networking_configs"',
    'left join "networking_profiles" on',
    'left join "registrations" on',
    'left join "networking_meetings"',
    'left join "networking_tables"',
    'left join "networking_connections" on ("networking_connections"."id" = $',
    'left join "networking_messages" on ("networking_messages"."id" = $',
    'left join "networking_profiles" "contact_profile"',
    'left join "registrations" "contact_registration"',
    'left join "networking_challenges" on (false',
    'left join "forms" on (false',
  ])
    expect(sql).toContain(joined);
  expect(sql).toContain('EXISTS (SELECT 1 FROM "networking_blocks"');
  // No event row: nothing else is read, and the context says so.
  expect(context).toMatchObject({ event: undefined, profile: undefined, blocked: false, subscriptions: [], consentPending: false });
});

it("joins the challenge and the consent form only for a sign-in code", async () => {
  await networkingDeliveryContext(row("OTP", { challengeId: "challenge" }));
  const sql = squash(recorded.queries[0]!);
  expect(sql).toContain('left join "networking_challenges" on ("networking_challenges"."id" = $');
  expect(sql).toContain('left join "forms" on (NOT "networking_profiles"."consent"');
});

it("reads every digest notice with the records it names in one statement", async () => {
  expect(await networkingDigestContexts(row("DAILY_DIGEST", { notificationIds: ["a", "b", 3] }), {} as never)).toEqual([]);
  expect(recorded.queries).toHaveLength(1);
  const sql = squash(recorded.queries[0]!);
  expect(sql).toContain('from "networking_notifications" inner join "networking_profiles"');
  expect(sql).toContain(`"networking_meetings"."id" = ("networking_notifications"."data" ->> 'meetingId')`);
  expect(sql).toContain('"networking_notifications"."id" in ($3, $4)');
  expect(await networkingDigestContexts(row("DAILY_DIGEST", { notificationIds: [] }), {} as never)).toEqual([]);
  expect(recorded.queries).toHaveLength(1);
});

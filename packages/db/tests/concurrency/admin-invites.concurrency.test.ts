import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import {
  committeeInviteTokens, countActiveSuperAdmins, deleteUser, getDb,
  insertCommitteeInvite, supersedeCommitteeInvite, updateUser,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedUser } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("concurrency: admin invariant and invite supersession", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it.each(["deactivate", "demote", "delete"] as const)(
    "keeps one active super admin when deactivation races with %s", async (operation) => {
      const a = await seedUser({ role: 0 });
      const b = await seedUser({ role: 0 });
      const results = await Promise.all([
        updateUser(a.id, { active: false }),
        operation === "delete" ? deleteUser(b.id) : updateUser(b.id,
          operation === "demote" ? { role: 2 } : { active: false }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: "last_super_admin" },
      ]);
      expect(await countActiveSuperAdmins()).toBe(1);
    },
  );

  it("leaves one delivered replacement usable after concurrent supersession", async () => {
    const user = await seedUser({ role: 2 });
    const event = await seedEvent();
    const data = { userId: user.id, eventId: event.id, expiresAt: new Date(Date.now() + 86400000) };
    await insertCommitteeInvite({ ...data, tokenHash: "old" });
    // Both sends have succeeded before either request starts superseding links.
    const a = await insertCommitteeInvite({ ...data, tokenHash: "delivered-a" });
    const b = await insertCommitteeInvite({ ...data, tokenHash: "delivered-b" });
    await Promise.all([supersedeCommitteeInvite(a.id), supersedeCommitteeInvite(b.id)]);
    const live = await getDb().select().from(committeeInviteTokens).where(isNull(committeeInviteTokens.usedAt));
    expect(live).toHaveLength(1);
    expect([a.id, b.id]).toContain(live[0].id);
    // A delayed loser cannot delete the surviving replacement on a retry either.
    const loser = live[0].id === a.id ? b.id : a.id;
    expect(await supersedeCommitteeInvite(loser)).toBe(false);
    expect(await getDb().select().from(committeeInviteTokens)
      .where(eq(committeeInviteTokens.id, live[0].id))).toHaveLength(1);
  });

  it("does not supersede invitations for other memberships", async () => {
    const user = await seedUser({ role: 2 });
    const event = await seedEvent();
    const otherEvent = await seedEvent();
    const data = { userId: user.id, expiresAt: new Date(Date.now() + 86400000) };
    const a = await insertCommitteeInvite({ ...data, eventId: event.id, tokenHash: "a" });
    const b = await insertCommitteeInvite({ ...data, eventId: otherEvent.id, tokenHash: "b" });
    await Promise.all([supersedeCommitteeInvite(a.id), supersedeCommitteeInvite(b.id)]);
    expect(await getDb().select().from(committeeInviteTokens)).toHaveLength(2);
  });
});

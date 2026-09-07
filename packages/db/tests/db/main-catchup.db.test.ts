import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  insertCommitteeInvite,
  replaceCommitteeInvite,
  claimCommitteeInvite,
  releaseCommitteeInvite,
  findCommitteeInviteById,
  findCommitteeInviteByHash,
  deleteUnusedCommitteeInvites,
  getDb,
  committeeInviteTokens,
  findAbstractsForExport,
  listAdminAbstracts,
  updateForm,
  findFormById,
  findPublicConfigData,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import {
  seedEvent,
  seedUser,
  seedAbstract,
  seedForm,
  seedAbstractConfig,
  seedAbstractTheme,
} from "../helpers/factories";

describe.runIf(dbTestsEnabled())(
  "main catchup: persistence, filters and invite concurrency",
  () => {
    beforeEach(cleanupDatabase);
    afterEach(cleanupDatabase);
    async function tokenData() {
      const event = await seedEvent();
      const user = await seedUser({ role: 2 });
      return {
        eventId: event.id,
        userId: user.id,
        tokenHash: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 86400000),
      };
    }
    it("only one concurrent token claim wins", async () => {
      const data = await tokenData();
      const row = await insertCommitteeInvite(data);
      expect((await findCommitteeInviteByHash(data.tokenHash))?.user.id).toBe(
        data.userId,
      );
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          claimCommitteeInvite(row.id, new Date()),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await findCommitteeInviteById(row.id))?.usedAt).not.toBeNull();
    });
    it("does not claim expired tokens", async () => {
      const row = await insertCommitteeInvite({
        ...(await tokenData()),
        expiresAt: new Date(0),
      });
      expect(await claimCommitteeInvite(row.id, new Date())).toBe(false);
    });
    it("releases a failed password claim if no replacement exists", async () => {
      const row = await insertCommitteeInvite(await tokenData());
      const now = new Date();
      expect(await claimCommitteeInvite(row.id, now)).toBe(true);
      await releaseCommitteeInvite(row, now);
      expect(await claimCommitteeInvite(row.id, new Date())).toBe(true);
    });
    it("does not resurrect a superseded link when releasing a failed claim", async () => {
      const data = await tokenData();
      const old = await insertCommitteeInvite(data);
      const now = new Date();
      await claimCommitteeInvite(old.id, now);
      const replacement = await replaceCommitteeInvite({
        ...data,
        tokenHash: "replacement",
      });
      await releaseCommitteeInvite(old, now);
      expect(await findCommitteeInviteById(old.id)).toBeNull();
      expect(await claimCommitteeInvite(replacement.id, new Date())).toBe(true);
    });
    it("concurrent minting leaves one unused invite and keeps used history", async () => {
      const data = await tokenData();
      const used = await insertCommitteeInvite(data);
      await claimCommitteeInvite(used.id, new Date());
      await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          replaceCommitteeInvite({ ...data, tokenHash: `new-${i}` }),
        ),
      );
      const rows = await getDb()
        .select()
        .from(committeeInviteTokens)
        .where(eq(committeeInviteTokens.userId, data.userId));
      expect(rows.filter((r) => !r.usedAt)).toHaveLength(1);
      expect(rows.filter((r) => r.usedAt)).toHaveLength(1);
    });
    it("password cleanup purges unused links across events, keeping used history", async () => {
      const data = await tokenData();
      const used = await insertCommitteeInvite(data);
      await claimCommitteeInvite(used.id, new Date());
      await insertCommitteeInvite({ ...data, tokenHash: "unused" });
      await insertCommitteeInvite({
        ...data,
        eventId: (await seedEvent()).id,
        tokenHash: "other-event",
      });
      await deleteUnusedCommitteeInvites(data.userId);
      expect(await getDb().select().from(committeeInviteTokens)).toHaveLength(
        1,
      );
      expect((await findCommitteeInviteById(used.id))?.usedAt).not.toBeNull();
    });
    it("lists and exports the same effective presentation type with AND search scoping", async () => {
      const event = await seedEvent();
      const pending = await seedAbstract({
        eventId: event.id,
        requestedType: "POSTER",
        finalType: null,
        authorLastName: "Match",
      });
      const changed = await seedAbstract({
        eventId: event.id,
        requestedType: "ORAL_COMMUNICATION",
        finalType: "POSTER",
        authorLastName: "Match",
      });
      await seedAbstract({
        eventId: event.id,
        requestedType: "POSTER",
        finalType: "CONFERENCE",
        authorLastName: "Match",
      });
      await seedAbstract({
        eventId: event.id,
        requestedType: "POSTER",
        authorLastName: "Other",
      });
      await seedAbstract({
        eventId: (await seedEvent()).id,
        requestedType: "POSTER",
        authorLastName: "Match",
      });
      const query = { presentationType: "POSTER" as const, q: "Match" };
      const list = await listAdminAbstracts(event.id, {
        ...query,
        limit: 1,
        offset: 0,
      });
      const exported = await findAbstractsForExport(event.id, query);
      expect(list.total).toBe(2);
      expect(list.items).toHaveLength(1);
      expect(exported.map((r) => r.id).sort()).toEqual(
        [pending.id, changed.id].sort(),
      );
      const conference = await findAbstractsForExport(event.id, {
        presentationType: "CONFERENCE",
      });
      expect(conference).toHaveLength(1);
      expect(conference[0].finalType).toBe("CONFERENCE");
    });
    it("round-trips multilingual settings/success copy and supports clearing success translations", async () => {
      const form = await seedForm();
      const schema = {
        steps: [],
        settings: {
          languages: ["fr", "en"],
          registrationFeeLabel: "Inscription",
          translations: { en: { registrationFeeLabel: "Registration" } },
        },
      };
      await updateForm(form.id, {
        schema,
        successTranslations: { en: { successTitle: "Done" } },
      });
      expect(await findFormById(form.id)).toMatchObject({
        schema,
        successTranslations: { en: { successTitle: "Done" } },
      });
      await updateForm(form.id, { successTranslations: null });
      expect((await findFormById(form.id))?.successTranslations).toBeNull();
    });
    it("returns abstract languages and theme translations through the public query", async () => {
      const event = await seedEvent();
      const config = await seedAbstractConfig({
        eventId: event.id,
        languages: ["fr", "ar"],
      });
      await seedAbstractTheme({
        configId: config.id,
        translations: { ar: { label: "موضوع" } },
      });
      expect(await findPublicConfigData(event.slug)).toMatchObject({
        config: { languages: ["fr", "ar"] },
        themes: [{ translations: { ar: { label: "موضوع" } } }],
      });
    });
  },
);

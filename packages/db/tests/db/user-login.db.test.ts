import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, getUserById, recordUserLogin } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedUser } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("last login persistence", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("is nullable, monotonic and does not change the profile modification date", async () => {
    const user = await seedUser();
    expect(user.lastLoginAt).toBeNull();
    const latest = new Date("2026-10-02T12:00:00Z");
    await recordUserLogin(user.id, latest, getDb());
    await recordUserLogin(user.id, new Date("2026-10-01T12:00:00Z"), getDb());
    expect(await getUserById(user.id)).toMatchObject({ lastLoginAt: latest, updatedAt: user.updatedAt });
  });
  it("does not record a login for an inactive user", async () => {
    const user = await seedUser({ active: false });
    await recordUserLogin(user.id, new Date(), getDb());
    expect((await getUserById(user.id))?.lastLoginAt).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, abstractThemes, deleteUnusedAbstractTheme } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedAbstractConfig, seedAbstractTheme, seedAbstract, linkAbstractTheme } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("permanent deletion of unused themes", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("removes an unused row but preserves a referenced theme and cross-event rows", async () => {
    const event = await seedEvent(); const other = await seedEvent();
    const config = await seedAbstractConfig({ eventId: event.id });
    const theme = await seedAbstractTheme({ configId: config.id });
    expect(await deleteUnusedAbstractTheme(other.id, theme.id)).toBe("NOT_FOUND");
    expect(await deleteUnusedAbstractTheme(event.id, theme.id)).toBe("DELETED");
    expect(await getDb().select().from(abstractThemes)).toEqual([]);
    const used = await seedAbstractTheme({ configId: config.id });
    const abstract = await seedAbstract({ eventId: event.id }); await linkAbstractTheme(abstract.id, used.id);
    expect(await deleteUnusedAbstractTheme(event.id, used.id)).toBe("IN_USE");
    expect(await getDb().select().from(abstractThemes)).toHaveLength(1);
  });
});

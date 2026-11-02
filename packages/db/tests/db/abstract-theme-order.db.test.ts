import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reorderAbstractThemes, listThemesByConfigId } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedAbstractConfig, seedAbstractTheme, seedAbstract, linkAbstractTheme } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("atomic theme order", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("swaps unique positions and refuses incomplete, duplicate or coded-theme moves without partial updates", async () => {
    const event = await seedEvent(); const config = await seedAbstractConfig({ eventId: event.id });
    const a = await seedAbstractTheme({ configId: config.id, sortOrder: 0 });
    const b = await seedAbstractTheme({ configId: config.id, sortOrder: 1 });
    expect(await reorderAbstractThemes(event.id, [b.id,a.id])).toMatchObject({ ok: true });
    expect((await listThemesByConfigId(config.id)).map(t => t.id)).toEqual([b.id,a.id]);
    expect(await reorderAbstractThemes(event.id, [a.id])).toMatchObject({ ok: false, reason: "INVALID_SET" });
    expect(await reorderAbstractThemes(event.id, [a.id,a.id])).toMatchObject({ ok: false, reason: "INVALID_SET" });
    const abstract = await seedAbstract({ eventId: event.id, code: "O1-01", codeNumber: 1 }); await linkAbstractTheme(abstract.id, a.id);
    expect(await reorderAbstractThemes(event.id, [a.id,b.id])).toMatchObject({ ok: false, reason: "CODED_THEME" });
    expect((await listThemesByConfigId(config.id)).map(t => t.id)).toEqual([b.id,a.id]);
  });
});

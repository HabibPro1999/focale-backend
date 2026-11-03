import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedBadgeZones } from "@app/contracts";
import {
  createBadgeTemplate,
  deleteBadgeTemplate,
  getBadgeTemplate,
  getBadgeTemplateImagesTx,
  getDb,
  listBadgeTemplates,
  setBadgeTemplateBackground,
  updateBadgeTemplate,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";

// 0042: badge template reads and writes against a migrated database.
describe.runIf(dbTestsEnabled())("db tier: badge templates", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const background = {
    backgroundUrl: "https://cdn.example.com/evt/badges/b-1.png",
    backgroundWidth: 1063,
    backgroundHeight: 650,
    renderImageKey: "evt/badges/b-1-render.jpg",
    renderImageWidth: 1063,
    renderImageHeight: 650,
  };

  it("creates, reads, updates and lists an event's badges, mm sizes as numbers", async () => {
    const event = await seedEvent();
    const zones = seedBadgeZones(85.6, 54);
    const created = await createBadgeTemplate({ eventId: event.id, name: "Attendee", widthMm: 85.6, heightMm: 54, zones }, getDb());
    expect(created).toMatchObject({ eventId: event.id, widthMm: 85.6, heightMm: 54, zones, backgroundUrl: null, deletedAt: null });

    expect(await getBadgeTemplate(created.id)).toMatchObject({ id: created.id, widthMm: 85.6, zones });

    const updated = await updateBadgeTemplate(created.id, { name: "Speaker", widthMm: 100, heightMm: 140 }, getDb());
    expect(updated).toMatchObject({ name: "Speaker", widthMm: 100, heightMm: 140, zones });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const second = await createBadgeTemplate({ eventId: event.id, name: "Staff", widthMm: 90, heightMm: 55, zones }, getDb());
    const other = await seedEvent();
    await createBadgeTemplate({ eventId: other.id, name: "Other", widthMm: 90, heightMm: 55, zones }, getDb());
    expect((await listBadgeTemplates(event.id)).map((b) => b.id)).toEqual([created.id, second.id]);
  });

  it("sets and clears the background images together", async () => {
    const event = await seedEvent();
    const badge = await createBadgeTemplate({ eventId: event.id, name: "B", widthMm: 90, heightMm: 55, zones: seedBadgeZones(90, 55) }, getDb());

    expect(await setBadgeTemplateBackground(badge.id, background, getDb())).toMatchObject(background);
    expect(await setBadgeTemplateBackground(badge.id, null, getDb())).toMatchObject({
      backgroundUrl: null, backgroundWidth: null, backgroundHeight: null,
      renderImageKey: null, renderImageWidth: null, renderImageHeight: null,
    });
  });

  it("soft-deletes: gone from every read and write, its images still listed for the event delete", async () => {
    const event = await seedEvent();
    const badge = await createBadgeTemplate({ eventId: event.id, name: "B", widthMm: 90, heightMm: 55, zones: seedBadgeZones(90, 55) }, getDb());
    await setBadgeTemplateBackground(badge.id, background, getDb());

    expect(await deleteBadgeTemplate(badge.id, getDb())).toBe(true);
    expect(await deleteBadgeTemplate(badge.id, getDb())).toBe(false);
    expect(await getBadgeTemplate(badge.id)).toBeNull();
    expect(await listBadgeTemplates(event.id)).toEqual([]);
    expect(await updateBadgeTemplate(badge.id, { name: "X" }, getDb())).toBeNull();
    expect(await setBadgeTemplateBackground(badge.id, null, getDb())).toBeNull();

    expect(await getBadgeTemplateImagesTx(getDb(), event.id)).toEqual([
      { backgroundUrl: background.backgroundUrl, renderImageKey: background.renderImageKey },
    ]);
  });
});

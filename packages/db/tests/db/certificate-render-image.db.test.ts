import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  certificateTemplates,
  getDb,
  listCertificateTemplatesMissingRenderImage,
  setCertificateTemplateRenderImage,
  updateCertificateTemplateImage,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";

// Certificate render images (3.8) on a migrated DB, both engines: the upload
// write, the backfill scan and its guarded write.
describe.runIf(dbTestsEnabled())("db: certificate render images", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const url = (id: string) => `https://cdn.example.com/certificates/${id}.png`;

  async function seedTemplate(
    id: string,
    eventId: string,
    values: Partial<typeof certificateTemplates.$inferInsert> = {},
  ) {
    await getDb()
      .insert(certificateTemplates)
      .values({
        id,
        eventId,
        name: id,
        templateUrl: url(id),
        templateWidth: 1200,
        templateHeight: 850,
        ...values,
      });
  }

  async function renderOf(id: string) {
    const [row] = await getDb()
      .select({
        key: certificateTemplates.renderImageKey,
        width: certificateTemplates.renderImageWidth,
        height: certificateTemplates.renderImageHeight,
      })
      .from(certificateTemplates)
      .where(eq(certificateTemplates.id, id));
    return row;
  }

  it("lists image-ready templates without a render image, active or not, in id order", async () => {
    const a = await seedEvent();
    const b = await seedEvent();
    await seedTemplate("tpl-1", a.id);
    await seedTemplate("tpl-2", a.id, {
      renderImageKey: "k",
      renderImageWidth: 10,
      renderImageHeight: 10,
    });
    await seedTemplate("tpl-3", a.id, { templateUrl: "", templateWidth: 0, templateHeight: 0 });
    await seedTemplate("tpl-4", b.id);
    await seedTemplate("tpl-5", a.id, { active: false });

    const ids = async (options: Parameters<typeof listCertificateTemplatesMissingRenderImage>[0]) =>
      (await listCertificateTemplatesMissingRenderImage(options)).map((t) => t.id);

    expect(await listCertificateTemplatesMissingRenderImage({ limit: 10 })).toEqual([
      { id: "tpl-1", eventId: a.id, templateUrl: url("tpl-1") },
      { id: "tpl-4", eventId: b.id, templateUrl: url("tpl-4") },
      { id: "tpl-5", eventId: a.id, templateUrl: url("tpl-5") },
    ]);
    expect(await ids({ eventId: a.id, limit: 10 })).toEqual(["tpl-1", "tpl-5"]);
    expect(await ids({ templateIds: ["tpl-2", "tpl-4"], limit: 10 })).toEqual(["tpl-4"]);
    expect(await ids({ templateIds: [], limit: 10 })).toEqual([]);
    expect(await ids({ limit: 1 })).toEqual(["tpl-1"]);
    expect(await ids({ afterId: "tpl-1", limit: 10 })).toEqual(["tpl-4", "tpl-5"]);
  });

  it("records a backfilled render image only while the template shows the same original without one", async () => {
    const event = await seedEvent();
    await seedTemplate("tpl-1", event.id);
    await seedTemplate("tpl-2", event.id);
    await seedTemplate("tpl-3", event.id, {
      renderImageKey: "existing",
      renderImageWidth: 5,
      renderImageHeight: 5,
    });
    const render = { renderImageKey: "new-key", renderImageWidth: 1200, renderImageHeight: 850 };

    expect(await setCertificateTemplateRenderImage("tpl-1", url("tpl-1"), render, getDb())).toBe(true);
    expect(await renderOf("tpl-1")).toEqual({ key: "new-key", width: 1200, height: 850 });

    // A new upload replaced the original while the backfill was rendering.
    expect(await setCertificateTemplateRenderImage("tpl-2", url("old"), render, getDb())).toBe(false);
    expect(await renderOf("tpl-2")).toEqual({ key: null, width: null, height: null });

    // Already rendered (by an upload or another run): never overwritten.
    expect(await setCertificateTemplateRenderImage("tpl-3", url("tpl-3"), render, getDb())).toBe(false);
    expect(await renderOf("tpl-3")).toEqual({ key: "existing", width: 5, height: 5 });

    expect(await setCertificateTemplateRenderImage("gone", url("gone"), render, getDb())).toBe(false);
  });

  it("the upload write stores the original and its render image together", async () => {
    const event = await seedEvent();
    await seedTemplate("tpl-1", event.id, { templateUrl: "", templateWidth: 0, templateHeight: 0 });

    const updated = await updateCertificateTemplateImage("tpl-1", {
      templateUrl: url("tpl-1-new"),
      templateWidth: 5000,
      templateHeight: 3000,
      renderImageKey: `${event.id}/certificates/tpl-1-u-render.jpg`,
      renderImageWidth: 3508,
      renderImageHeight: 2105,
    }, getDb());

    expect(updated).toMatchObject({
      templateUrl: url("tpl-1-new"),
      templateWidth: 5000,
      templateHeight: 3000,
      renderImageKey: `${event.id}/certificates/tpl-1-u-render.jpg`,
      renderImageWidth: 3508,
      renderImageHeight: 2105,
    });
    expect(await listCertificateTemplatesMissingRenderImage({ limit: 10 })).toEqual([]);
  });
});

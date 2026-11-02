import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { certificateTemplates, getDb, deleteCertificateTemplateById, restoreCertificateTemplate,
  listCertificateTemplates, getCertificateTemplateWithEvent, listActiveImageReadyCertificateTemplates,
  getActiveImageReadyCertificateTemplatesByIds, updateCertificateTemplate } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("certificate template restoration", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("retains assets, hides deleted templates from reads and worker sends, then restores them", async () => {
    const event = await seedEvent();
    const [template] = await getDb().insert(certificateTemplates).values({ eventId: event.id, name: "Certificate",
      templateUrl: "https://example.test/image.png", templateWidth: 100, templateHeight: 100,
      renderImageKey: `${event.id}/certificates/render.jpg` }).returning();
    await deleteCertificateTemplateById(template.id, getDb());
    const retained = (await getDb().select().from(certificateTemplates).where(eq(certificateTemplates.id, template.id)))[0];
    expect(retained).toMatchObject({ templateUrl: template.templateUrl, renderImageKey: template.renderImageKey });
    expect(retained.deletedAt).toBeInstanceOf(Date);
    expect(await listCertificateTemplates(event.id)).toEqual([]);
    expect(await getCertificateTemplateWithEvent(template.id)).toBeNull();
    expect(await listActiveImageReadyCertificateTemplates(event.id)).toEqual([]);
    expect(await getActiveImageReadyCertificateTemplatesByIds([template.id], event.id)).toEqual([]);
    await updateCertificateTemplate(template.id, { name: "Should not change" }, getDb());
    expect(await restoreCertificateTemplate(template.id, getDb())).toMatchObject({ id: template.id, name: "Certificate", active: true });
    expect(await restoreCertificateTemplate(template.id, getDb())).toMatchObject({ id: template.id });
    expect(await listActiveImageReadyCertificateTemplates(event.id)).toHaveLength(1);
  });
});

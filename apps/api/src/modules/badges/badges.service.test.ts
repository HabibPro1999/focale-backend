import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { ErrorCodes, seedBadgeZones } from "@app/contracts";

// Real file-type, sharp and PDF rendering; the DB and storage are stubbed.
const rootDb = vi.hoisted(() => ({ executor: "root" }));
vi.mock("@app/db", () => ({
  getDb: () => rootDb,
  createBadgeTemplate: vi.fn(),
  deleteBadgeTemplate: vi.fn(),
  getBadgeTemplate: vi.fn(),
  getRegistrationForEmailContext: vi.fn(),
  getRegistrationFormLanguage: vi.fn(async () => "en"),
  // Read by the real email variable catalogue (form-field examples in sample.pdf).
  getRegistrationFormSchema: vi.fn(async () => ({
    steps: [{ fields: [
      { id: "company", type: "text", label: "Company" },
      { id: "intro", type: "heading", label: "About you" },
      { id: "country", type: "dropdown", label: "Country" },
    ] }],
  })),
  listBadgeTemplates: vi.fn(),
  setBadgeTemplateBackground: vi.fn(),
  updateBadgeTemplate: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  uploadPublic: vi.fn(async (_b: Buffer, key: string, _type: string) => `https://storage.googleapis.com/bucket/${key}`),
  uploadPrivate: vi.fn(async (_b: Buffer, key: string, _type: string) => key),
  delete: vi.fn(),
  download: vi.fn(),
}));
const generateBadgePdf = vi.hoisted(() => vi.fn());
vi.mock("@app/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/integrations")>();
  generateBadgePdf.mockImplementation(actual.generateBadgePdf);
  return {
    ...actual,
    getStorageProvider: () => storage,
    generateBadgePdf,
    buildEmailContextWithAccess: vi.fn(async () => ({ fullName: "Leila Ben Ali", form_company: "Focale", _snapshot: 1 })),
  };
});

import {
  createBadgeTemplate,
  deleteBadgeTemplate,
  getBadgeTemplate,
  getRegistrationForEmailContext,
  listBadgeTemplates,
  setBadgeTemplateBackground,
  updateBadgeTemplate,
} from "@app/db";
import { buildEmailContextWithAccess, SAMPLE_REGISTRATION_ID } from "@app/integrations";
import { BadgesService } from "./badges.service";

const service = new BadgesService();
const EVENT = "evt-1";
const ID = "11111111-1111-4111-8111-111111111111";
const REG = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a12";

function row(overrides: object = {}) {
  return {
    id: ID,
    eventId: EVENT,
    name: "Attendee",
    widthMm: 90,
    heightMm: 55,
    backgroundUrl: null,
    backgroundWidth: null,
    backgroundHeight: null,
    renderImageKey: null,
    renderImageWidth: null,
    renderImageHeight: null,
    zones: seedBadgeZones(90, 55),
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as never;
}

const apiShape = (overrides: object = {}) => {
  const { renderImageKey: _k, renderImageWidth: _w, renderImageHeight: _h, deletedAt: _d, ...rest } = row(overrides) as Record<string, unknown>;
  return rest;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CRUD", () => {
  it("creates a badge with the seeded zones when the body has none", async () => {
    vi.mocked(createBadgeTemplate).mockImplementation(async (values) => row(values) as never);
    const created = await service.create(EVENT, { name: "Attendee", widthMm: 105, heightMm: 148 });
    expect(createBadgeTemplate).toHaveBeenCalledWith({
      eventId: EVENT, name: "Attendee", widthMm: 105, heightMm: 148, zones: seedBadgeZones(105, 148),
    }, rootDb);
    expect(created).toEqual(apiShape({ widthMm: 105, heightMm: 148, zones: seedBadgeZones(105, 148) }));
    expect(created).not.toHaveProperty("renderImageKey");
  });

  it("keeps the zones a create body gives", async () => {
    const zones = [{ kind: "qr" as const, id: "q", x: 0, y: 0, width: 50, height: 50 }];
    vi.mocked(createBadgeTemplate).mockImplementation(async (values) => row(values) as never);
    await service.create(EVENT, { name: "B", widthMm: 90, heightMm: 55, zones });
    expect(vi.mocked(createBadgeTemplate).mock.calls[0]![0].zones).toBe(zones);
  });

  it("lists, reads, updates and deletes; a missing badge is 404 BDG_21001", async () => {
    vi.mocked(listBadgeTemplates).mockResolvedValue([row()]);
    expect(await service.list(EVENT)).toEqual([apiShape()]);

    vi.mocked(getBadgeTemplate).mockResolvedValueOnce(row());
    expect(await service.get(ID)).toEqual(apiShape());
    vi.mocked(getBadgeTemplate).mockResolvedValueOnce(null);
    await expect(service.get(ID)).rejects.toMatchObject({ status: 404, code: ErrorCodes.BADGE_TEMPLATE_NOT_FOUND });

    vi.mocked(updateBadgeTemplate).mockResolvedValueOnce(row({ name: "Speaker" }));
    expect(await service.update(ID, { name: "Speaker" })).toMatchObject({ name: "Speaker" });
    expect(updateBadgeTemplate).toHaveBeenCalledWith(ID, { name: "Speaker" }, rootDb);
    vi.mocked(updateBadgeTemplate).mockResolvedValueOnce(null);
    await expect(service.update(ID, { name: "X" })).rejects.toMatchObject({ code: ErrorCodes.BADGE_TEMPLATE_NOT_FOUND });

    vi.mocked(deleteBadgeTemplate).mockResolvedValueOnce(true);
    await expect(service.delete(ID)).resolves.toBeUndefined();
    vi.mocked(deleteBadgeTemplate).mockResolvedValueOnce(false);
    await expect(service.delete(ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("background", () => {
  const png = () => sharp({ create: { width: 900, height: 550, channels: 4, background: { r: 10, g: 80, b: 200, alpha: 0.5 } } }).png().toBuffer();
  const file = (buffer: Buffer) => ({ buffer, filename: "bg.png", mimetype: "image/png" });

  it("stores the original (public) and its flattened JPEG render (private) under the event's badges prefix", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    vi.mocked(setBadgeTemplateBackground).mockImplementation(async (_id, bg) => row(bg ?? {}) as never);

    const updated = await service.uploadBackground(ID, file(await png()));

    const [, key, mime] = storage.uploadPublic.mock.calls[0]!;
    expect(key).toMatch(new RegExp(`^${EVENT}/badges/${ID}-[0-9a-f-]{36}\\.png$`));
    expect(mime).toBe("image/png");
    const [renderBuffer, renderKey, renderType] = storage.uploadPrivate.mock.calls[0]!;
    expect(renderKey).toBe(String(key).replace(/\.png$/, "-render.jpg"));
    expect(renderType).toBe("image/jpeg");
    expect((await sharp(renderBuffer).metadata()).format).toBe("jpeg");
    expect(setBadgeTemplateBackground).toHaveBeenCalledWith(ID, {
      backgroundUrl: `https://storage.googleapis.com/bucket/${key}`,
      backgroundWidth: 900,
      backgroundHeight: 550,
      renderImageKey: renderKey,
      renderImageWidth: 900,
      renderImageHeight: 550,
    }, rootDb);
    expect(updated).toMatchObject({ backgroundUrl: `https://storage.googleapis.com/bucket/${key}`, backgroundWidth: 900 });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("deletes the previous images once the row points at the new ones", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row({
      backgroundUrl: `https://storage.googleapis.com/bucket/${EVENT}/badges/${ID}-old.png`,
      renderImageKey: `${EVENT}/badges/${ID}-old-render.jpg`,
    }));
    vi.mocked(setBadgeTemplateBackground).mockImplementation(async (_id, bg) => row(bg ?? {}) as never);
    await service.uploadBackground(ID, file(await png()));
    expect(storage.delete.mock.calls.map(([k]) => k)).toEqual([
      `${EVENT}/badges/${ID}-old.png`,
      `${EVENT}/badges/${ID}-old-render.jpg`,
    ]);
  });

  it.each([
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary")],
    ["text", Buffer.from("not an image")],
  ])("refuses %s with 400 BDG_21003 before any read or upload", async (_name, buffer) => {
    await expect(service.uploadBackground(ID, file(buffer))).rejects.toMatchObject({ status: 400, code: ErrorCodes.BADGE_IMAGE_INVALID });
    expect(getBadgeTemplate).not.toHaveBeenCalled();
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("refuses an image over 20 megapixels with 400 BDG_21003", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    const big = await sharp({ create: { width: 5000, height: 4100, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(service.uploadBackground(ID, file(big))).rejects.toMatchObject({ status: 400, code: ErrorCodes.BADGE_IMAGE_INVALID });
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("removes the stored images when the badge was deleted during the upload (404)", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    vi.mocked(setBadgeTemplateBackground).mockResolvedValue(null);
    await expect(service.uploadBackground(ID, file(await png()))).rejects.toMatchObject({ status: 404 });
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it("removes the background: clears the row, deletes both images", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row({
      backgroundUrl: `https://storage.googleapis.com/bucket/${EVENT}/badges/${ID}-a.png`,
      renderImageKey: `${EVENT}/badges/${ID}-a-render.jpg`,
    }));
    vi.mocked(setBadgeTemplateBackground).mockResolvedValue(row());
    expect(await service.removeBackground(ID)).toMatchObject({ backgroundUrl: null });
    expect(setBadgeTemplateBackground).toHaveBeenCalledWith(ID, null, rootDb);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it("proxies the original background; 404 without one", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row({ backgroundUrl: `https://storage.googleapis.com/bucket/${EVENT}/badges/x.png` }));
    storage.download.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });
    expect(await service.downloadBackground(ID)).toEqual({ buffer: Buffer.from("png"), contentType: "image/png" });
    expect(storage.download).toHaveBeenCalledWith(`${EVENT}/badges/x.png`);

    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    await expect(service.downloadBackground(ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("PDF renders", () => {
  it("sample.pdf: the sample registration and sample values, named after the sample number", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    const { pdf, filename } = await service.samplePdf(ID);
    expect(filename).toBe("badge-5A7C3E91.pdf");
    // pdf-lib parsing is covered by the integrations badge-pdf test.
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const [, values, registrationId] = generateBadgePdf.mock.calls[0]!;
    expect(registrationId).toBe(SAMPLE_REGISTRATION_ID);
    expect(values).toMatchObject({ fullName: "John Doe", registrationNumber: "5A7C3E91" });
  });

  it("sample.pdf: form fields draw their catalogue example (the canvas's sample), headings none", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());
    await service.samplePdf(ID);
    const [, values] = generateBadgePdf.mock.calls[0]!;
    expect(values).toMatchObject({ form_company: "Sample text", form_country: "Option A", fullName: "John Doe" });
    expect(values).not.toHaveProperty("form_intro");
  });

  it("registration badge.pdf: the registrant's email context, the badge of their event", async () => {
    const registration = { id: REG, eventId: EVENT };
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(getBadgeTemplate).mockResolvedValue(row());

    const { pdf, filename } = await service.registrationPdf(REG, ID);

    expect(filename).toBe("badge-3F2B8C1E.pdf");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buildEmailContextWithAccess).toHaveBeenCalledWith(registration);
    expect(generateBadgePdf).toHaveBeenCalledWith(row(), { fullName: "Leila Ben Ali", form_company: "Focale" }, REG);
  });

  it("registration badge.pdf: 404 for a badge of another event, a missing badge or registration", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue({ id: REG, eventId: EVENT } as never);
    vi.mocked(getBadgeTemplate).mockResolvedValueOnce(row({ eventId: "evt-2" }));
    await expect(service.registrationPdf(REG, ID)).rejects.toMatchObject({ status: 404, code: ErrorCodes.BADGE_TEMPLATE_NOT_FOUND });
    vi.mocked(getBadgeTemplate).mockResolvedValueOnce(null);
    await expect(service.registrationPdf(REG, ID)).rejects.toMatchObject({ status: 404, code: ErrorCodes.BADGE_TEMPLATE_NOT_FOUND });

    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(null);
    await expect(service.registrationPdf(REG, ID)).rejects.toMatchObject({ status: 404, code: ErrorCodes.REGISTRATION_NOT_FOUND });
    expect(generateBadgePdf).not.toHaveBeenCalled();
  });

  it("refuses to render a stored badge without exactly one QR zone (400 BDG_21002)", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row({ zones: [] }));
    await expect(service.samplePdf(ID)).rejects.toMatchObject({ status: 400, code: ErrorCodes.BADGE_QR_ZONE_REQUIRED });
  });
});

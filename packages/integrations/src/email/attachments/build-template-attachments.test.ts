import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { seedBadgeZones } from "@app/contracts";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@app/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/shared")>()),
  createLogger: () => log,
}));
vi.mock("@app/db", () => ({ getBadgeTemplate: vi.fn() }));

import { getBadgeTemplate } from "@app/db";
import { buildTemplateAttachments } from "./build-template-attachments";
import { renderRegistrationQrPng } from "./registration-qr";
import { mmToPt } from "../../badges/badge-pdf";

const REGISTRATION_ID = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a12";
const EVENT_ID = "evt-1";
const BADGE_ID = "11111111-1111-4111-8111-111111111111";
const context = { fullName: "Leila Ben Ali", registrationNumber: "3F2B8C1E", _certificateTemplateIds: ["x"] };
const target = { registrationId: REGISTRATION_ID, eventId: EVENT_ID, context };

const badge = {
  id: BADGE_ID,
  eventId: EVENT_ID,
  name: "Attendee",
  widthMm: 90,
  heightMm: 55,
  renderImageKey: null,
  zones: seedBadgeZones(90, 55),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTemplateAttachments", () => {
  it("attaches nothing when the template configures nothing", async () => {
    await expect(buildTemplateAttachments([], target)).resolves.toEqual([]);
  });

  it("attaches the registration's check-in QR as a named PNG", async () => {
    const attachments = await buildTemplateAttachments([{ type: "REGISTRATION_QR" }], target);

    expect(attachments).toEqual([
      {
        filename: "checkin-qr-3F2B8C1E.png",
        type: "image/png",
        disposition: "attachment",
        content: (await renderRegistrationQrPng(REGISTRATION_ID)).toString("base64"),
      },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("skips each attachment with a warning when the email has no registration (%s)", async (registrationId) => {
    const attachments = await buildTemplateAttachments(
      [{ type: "REGISTRATION_QR" }, { type: "REGISTRATION_BADGE", badgeTemplateId: BADGE_ID }],
      { ...target, registrationId, emailLogId: "log-1" },
    );

    expect(attachments).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      { emailLogId: "log-1", attachment: "REGISTRATION_QR" },
      "Template attachment skipped: the email has no registration",
    );
    expect(log.warn).toHaveBeenCalledWith(
      { emailLogId: "log-1", attachment: "REGISTRATION_BADGE" },
      "Template attachment skipped: the email has no registration",
    );
    expect(getBadgeTemplate).not.toHaveBeenCalled();
  });

  it("attaches the badge as badge-<REGNUM>.pdf, rendered from the email's context, after the QR", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(badge as never);

    const attachments = await buildTemplateAttachments(
      [{ type: "REGISTRATION_QR" }, { type: "REGISTRATION_BADGE", badgeTemplateId: BADGE_ID }],
      target,
    );

    expect(getBadgeTemplate).toHaveBeenCalledWith(BADGE_ID);
    expect(attachments.map((a) => [a.filename, a.type, a.disposition])).toEqual([
      ["checkin-qr-3F2B8C1E.png", "image/png", "attachment"],
      ["badge-3F2B8C1E.pdf", "application/pdf", "attachment"],
    ]);
    const pdf = Buffer.from(attachments[1]!.content, "base64");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: mmToPt(90), height: mmToPt(55) });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted or missing", null],
    ["of another event", { ...badge, eventId: "evt-other" }],
  ])("skips a badge %s with a warning; the other attachments still go", async (_case, row) => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(row as never);

    const attachments = await buildTemplateAttachments(
      [{ type: "REGISTRATION_BADGE", badgeTemplateId: BADGE_ID }, { type: "REGISTRATION_QR" }],
      { ...target, emailLogId: "log-2" },
    );

    expect(attachments.map((a) => a.filename)).toEqual(["checkin-qr-3F2B8C1E.png"]);
    expect(log.warn).toHaveBeenCalledWith(
      { emailLogId: "log-2", attachment: "REGISTRATION_BADGE", badgeTemplateId: BADGE_ID },
      "Template attachment skipped: the badge template is deleted or not the event's",
    );
  });

  it("never attaches a badge when the template has no event", async () => {
    vi.mocked(getBadgeTemplate).mockResolvedValue(badge as never);
    const attachments = await buildTemplateAttachments(
      [{ type: "REGISTRATION_BADGE", badgeTemplateId: BADGE_ID }],
      { ...target, eventId: null },
    );
    expect(attachments).toEqual([]);
  });
});

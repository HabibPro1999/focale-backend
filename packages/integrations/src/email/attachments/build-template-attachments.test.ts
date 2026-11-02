import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@app/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/shared")>()),
  createLogger: () => log,
}));

import { buildTemplateAttachments } from "./build-template-attachments";
import { renderRegistrationQrPng } from "./registration-qr";

const REGISTRATION_ID = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a12";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTemplateAttachments", () => {
  it("attaches nothing when the template configures nothing", async () => {
    await expect(buildTemplateAttachments([], { registrationId: REGISTRATION_ID })).resolves.toEqual([]);
  });

  it("attaches the registration's check-in QR as a named PNG", async () => {
    const attachments = await buildTemplateAttachments([{ type: "REGISTRATION_QR" }], {
      registrationId: REGISTRATION_ID,
    });

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

  it.each([null, undefined])("skips the QR with a warning when the email has no registration (%s)", async (registrationId) => {
    const attachments = await buildTemplateAttachments([{ type: "REGISTRATION_QR" }], {
      registrationId,
      emailLogId: "log-1",
    });

    expect(attachments).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      { emailLogId: "log-1", attachment: "REGISTRATION_QR" },
      "Template attachment skipped: the email has no registration",
    );
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { downloadTemplateImage } from "./certificates.service.js";
import {
  __certificatePdfTestHooks,
  generateCertificateAttachments,
  generateCertificatePdf,
} from "./certificate-pdf.service.js";
import type {
  CertificateTemplateData,
  RegistrationForCertificate,
} from "./certificate-pdf.service.js";
import type { CertificateZone } from "./certificates.schema.js";

vi.mock("./certificates.service.js", () => ({
  downloadTemplateImage: vi.fn(),
}));

const mockDownloadTemplateImage = vi.mocked(downloadTemplateImage);
const pngOneByOne = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const zone = (overrides: Partial<CertificateZone> = {}): CertificateZone => ({
  id: "zone-1",
  x: 10,
  y: 40,
  width: 80,
  height: 20,
  variable: "fullName",
  fontSize: null,
  fontWeight: "bold",
  color: "#000000",
  textAlign: "center",
  ...overrides,
});

const registration: RegistrationForCertificate = {
  id: "registration-123456",
  firstName: "ليلى",
  lastName: "Müller",
  role: "PARTICIPANT",
  checkedInAt: new Date("2026-05-01T10:00:00.000Z"),
  accessCheckIns: [],
  event: {
    name: "Focale OS",
    startDate: new Date("2026-05-01T00:00:00.000Z"),
    location: "Tunis",
  },
};

const template = (
  overrides: Partial<CertificateTemplateData> = {},
): CertificateTemplateData => ({
  id: "template-123456",
  name: "Attendance Certificate",
  templateUrl: "https://storage.example.com/certificate.png",
  templateWidth: 1000,
  templateHeight: 700,
  zones: [zone()],
  applicableRoles: [],
  accessId: null,
  access: null,
  ...overrides,
});

describe("certificate PDF generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadTemplateImage.mockResolvedValue({
      buffer: pngOneByOne,
      contentType: "image/png",
    });
  });

  it("generates PDFs for Unicode certificate text", async () => {
    const pdf = await generateCertificatePdf(
      template({
        zones: [
          zone({
            color: "rgb(32, 64, 96)",
            fontSize: 42,
          }),
        ],
      }),
      { fullName: "ليلى Müller" },
      new Map(),
    );

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("parses supported CSS color formats", () => {
    expect(__certificatePdfTestHooks.hexToRgb("#fff")).toEqual({
      r: 1,
      g: 1,
      b: 1,
    });
    expect(__certificatePdfTestHooks.hexToRgb("rgb(12, 34, 56)")).toEqual({
      r: 12 / 255,
      g: 34 / 255,
      b: 56 / 255,
    });
    expect(__certificatePdfTestHooks.hexToRgb("blue")).toEqual({
      r: 0,
      g: 0,
      b: 1,
    });
  });

  it("uses stable fallback and unique filename segments", async () => {
    const attachments = await generateCertificateAttachments(
      registration,
      [template({ name: "!!!" })],
      new Map(),
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("certificate-template-registra.pdf");
  });

  it("fails the attachment batch when an expected PDF cannot be generated", async () => {
    mockDownloadTemplateImage.mockResolvedValueOnce({
      buffer: Buffer.from("not-an-image"),
      contentType: "application/octet-stream",
    });

    await expect(
      generateCertificateAttachments(registration, [template()], new Map()),
    ).rejects.toThrow("Unsupported image format");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CertificateZone } from "@app/contracts";

// certificates-pdf downloads the template background through the storage
// provider and (for the worker seam) re-fetches via @app/db. Mock both.
const mockDownload = vi.fn();

vi.mock("./storage/index", () => ({
  getStorageProvider: vi.fn(() => ({ download: mockDownload })),
}));

vi.mock("@app/db", () => ({
  getRegistrationForCertificateGeneration: vi.fn(),
  getAbstractForCertificateGeneration: vi.fn(),
  getActiveImageReadyCertificateTemplatesByIds: vi.fn(),
}));

import {
  getRegistrationForCertificateGeneration,
  getAbstractForCertificateGeneration,
  getActiveImageReadyCertificateTemplatesByIds,
} from "@app/db";
import {
  __certificatePdfTestHooks,
  generateCertificateEmailAttachments,
  generateCertificateAttachments,
  generateAbstractCertificateAttachments,
  generateCertificatePdf,
  isEligibleForCertificate,
  resolveCertificateVariable,
} from "./certificates-pdf";
import type {
  AbstractForCertificate,
  CertificateTemplateData,
  RegistrationForCertificate,
} from "./certificates-pdf";

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

// H2: presenter certificate subject — no role/checkedInAt/accessCheckIns.
const abstract = (
  overrides: Partial<AbstractForCertificate> = {},
): AbstractForCertificate => ({
  id: "abstract-123456",
  authorFirstName: "Ada",
  authorLastName: "Lovelace",
  finalType: "ORAL_COMMUNICATION",
  requestedType: "ORAL_COMMUNICATION",
  code: "ABS-001",
  content: { title: "On Computing Engines" },
  event: {
    name: "Focale OS",
    startDate: new Date("2026-05-01T00:00:00.000Z"),
    location: "Tunis",
  },
  ...overrides,
});

describe("certificate PDF generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue({
      buffer: pngOneByOne,
      contentType: "image/png",
    });
  });

  it("generates PDFs for Unicode certificate text", async () => {
    const pdf = await generateCertificatePdf(
      template({
        zones: [zone({ color: "rgb(32, 64, 96)", fontSize: 42 })],
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
    mockDownload.mockResolvedValueOnce({
      buffer: Buffer.from("not-an-image"),
      contentType: "application/octet-stream",
    });

    await expect(
      generateCertificateAttachments(registration, [template()], new Map()),
    ).rejects.toThrow("Unsupported image format");
  });
});

describe("resolveCertificateVariable (H2 abstract variables)", () => {
  it("resolves author name + abstract title/code/finalType", () => {
    const data = {
      firstName: "Ada",
      lastName: "Lovelace",
      abstractTitle: "On Computing Engines",
      abstractCode: "ABS-001",
      abstractFinalType: "ORAL_COMMUNICATION",
    };
    expect(resolveCertificateVariable("fullName", data)).toBe("Ada Lovelace");
    expect(resolveCertificateVariable("abstractTitle", data)).toBe(
      "On Computing Engines",
    );
    expect(resolveCertificateVariable("abstractCode", data)).toBe("ABS-001");
    expect(resolveCertificateVariable("abstractFinalType", data)).toBe(
      "ORAL_COMMUNICATION",
    );
  });

  it("falls back to em dash when abstract fields are absent", () => {
    expect(resolveCertificateVariable("abstractTitle", {})).toBe("—");
    expect(resolveCertificateVariable("abstractCode", {})).toBe("—");
    expect(resolveCertificateVariable("abstractFinalType", {})).toBe("—");
  });
});

describe("generateAbstractCertificateAttachments (H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue({
      buffer: pngOneByOne,
      contentType: "image/png",
    });
  });

  it("renders presenter certificates from the abstract's own fields", async () => {
    const attachments = await generateAbstractCertificateAttachments(
      abstract(),
      [template({ zones: [zone({ variable: "abstractTitle" })] })],
      new Map(),
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("application/pdf");
  });

  it("does not gate on applicableRoles/accessId (abstracts have no role/check-in state)", async () => {
    // A registration with role PARTICIPANT would fail isEligibleForCertificate
    // against a SPEAKER-only, access-gated template — the abstract path has no
    // such filter, so this must still render.
    const attachments = await generateAbstractCertificateAttachments(
      abstract(),
      [template({ applicableRoles: ["SPEAKER"], accessId: "acc-1" })],
      new Map(),
    );

    expect(attachments).toHaveLength(1);
  });

  it("uses the abstract's own title/code/finalType untitled fallback when content has no title", async () => {
    const attachments = await generateAbstractCertificateAttachments(
      abstract({ content: {}, code: null, finalType: null }),
      [template({ zones: [zone({ variable: "abstractTitle" })] })],
      new Map(),
    );

    expect(attachments).toHaveLength(1);
  });
});

describe("isEligibleForCertificate", () => {
  it("requires a matching role when applicableRoles is non-empty", () => {
    expect(
      isEligibleForCertificate(registration, template({ applicableRoles: ["SPEAKER"] })),
    ).toBe(false);
    expect(
      isEligibleForCertificate(
        registration,
        template({ applicableRoles: ["PARTICIPANT"] }),
      ),
    ).toBe(true);
  });

  it("empty applicableRoles = all roles eligible (event-level check-in)", () => {
    expect(isEligibleForCertificate(registration, template())).toBe(true);
    expect(
      isEligibleForCertificate(
        { ...registration, checkedInAt: null },
        template(),
      ),
    ).toBe(false);
  });

  it("access-specific cert requires a check-in for that access", () => {
    const t = template({ accessId: "acc-1" });
    expect(isEligibleForCertificate(registration, t)).toBe(false);
    expect(
      isEligibleForCertificate(
        { ...registration, accessCheckIns: [{ accessId: "acc-1" }] },
        t,
      ),
    ).toBe(true);
  });
});

describe("generateCertificateEmailAttachments (worker seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue({
      buffer: pngOneByOne,
      contentType: "image/png",
    });
  });

  it("throws when a queued template is no longer active/image-ready", async () => {
    vi.mocked(getRegistrationForCertificateGeneration).mockResolvedValue({
      id: "registration-123456",
      firstName: "Ada",
      lastName: "Lovelace",
      role: "PARTICIPANT",
      checkedInAt: new Date(),
      accessCheckIns: [],
      event: {
        id: "evt-1",
        name: "Focale OS",
        startDate: new Date(),
        location: "Tunis",
      },
    });
    // Two templates queued, only one still active → mismatch → throw.
    vi.mocked(getActiveImageReadyCertificateTemplatesByIds).mockResolvedValue([
      { ...template(), zones: [] } as never,
    ]);

    await expect(
      generateCertificateEmailAttachments({
        registrationId: "registration-123456",
        certificateTemplateIds: ["template-123456", "template-999999"],
        imageCache: new Map(),
      }),
    ).rejects.toThrow("no longer active");
  });

  it("renders attachments for still-active templates", async () => {
    vi.mocked(getRegistrationForCertificateGeneration).mockResolvedValue({
      id: "registration-123456",
      firstName: "Ada",
      lastName: "Lovelace",
      role: "PARTICIPANT",
      checkedInAt: new Date(),
      accessCheckIns: [],
      event: {
        id: "evt-1",
        name: "Focale OS",
        startDate: new Date(),
        location: "Tunis",
      },
    });
    vi.mocked(getActiveImageReadyCertificateTemplatesByIds).mockResolvedValue([
      { ...template(), zones: [] } as never,
    ]);

    const attachments = await generateCertificateEmailAttachments({
      registrationId: "registration-123456",
      certificateTemplateIds: ["template-123456"],
      imageCache: new Map(),
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe("application/pdf");
  });

  it("throws when the registration no longer exists", async () => {
    vi.mocked(getRegistrationForCertificateGeneration).mockResolvedValue(null);

    await expect(
      generateCertificateEmailAttachments({
        registrationId: "gone",
        certificateTemplateIds: ["template-123456"],
        imageCache: new Map(),
      }),
    ).rejects.toThrow("Registration not found");
  });

  it("throws when neither registrationId nor abstractId is set on the context", async () => {
    await expect(
      generateCertificateEmailAttachments({
        certificateTemplateIds: ["template-123456"],
        imageCache: new Map(),
      }),
    ).rejects.toThrow(
      "Certificate attachment context has neither registrationId nor abstractId",
    );
  });

  // H2: abstract-linked CERTIFICATE_SENT rows carry abstractId instead of
  // registrationId — the generator must branch to the abstract path and never
  // touch getRegistrationForCertificateGeneration.
  describe("abstract path (H2)", () => {
    it("renders attachments via the abstract path when abstractId is set", async () => {
      vi.mocked(getAbstractForCertificateGeneration).mockResolvedValue({
        id: "abstract-123456",
        authorFirstName: "Ada",
        authorLastName: "Lovelace",
        finalType: "ORAL_COMMUNICATION",
        requestedType: "ORAL_COMMUNICATION",
        code: "ABS-001",
        content: { title: "On Computing Engines" },
        event: {
          id: "evt-1",
          name: "Focale OS",
          startDate: new Date(),
          location: "Tunis",
        },
      });
      vi.mocked(getActiveImageReadyCertificateTemplatesByIds).mockResolvedValue([
        { ...template(), zones: [] } as never,
      ]);

      const attachments = await generateCertificateEmailAttachments({
        abstractId: "abstract-123456",
        certificateTemplateIds: ["template-123456"],
        imageCache: new Map(),
      });

      expect(attachments).toHaveLength(1);
      expect(attachments[0].type).toBe("application/pdf");
      expect(getRegistrationForCertificateGeneration).not.toHaveBeenCalled();
      expect(getActiveImageReadyCertificateTemplatesByIds).toHaveBeenCalledWith(
        ["template-123456"],
        "evt-1",
      );
    });

    it("throws when the abstract no longer exists (deleted/never existed)", async () => {
      vi.mocked(getAbstractForCertificateGeneration).mockResolvedValue(null);

      await expect(
        generateCertificateEmailAttachments({
          abstractId: "gone",
          certificateTemplateIds: ["template-123456"],
          imageCache: new Map(),
        }),
      ).rejects.toThrow("Abstract not found");
    });

    it("throws when a queued template is no longer active for the abstract's event", async () => {
      vi.mocked(getAbstractForCertificateGeneration).mockResolvedValue({
        id: "abstract-123456",
        authorFirstName: "Ada",
        authorLastName: "Lovelace",
        finalType: "ORAL_COMMUNICATION",
        requestedType: "ORAL_COMMUNICATION",
        code: "ABS-001",
        content: { title: "On Computing Engines" },
        event: {
          id: "evt-1",
          name: "Focale OS",
          startDate: new Date(),
          location: "Tunis",
        },
      });
      // Two templates queued, only one still active → mismatch → throw.
      vi.mocked(getActiveImageReadyCertificateTemplatesByIds).mockResolvedValue([
        { ...template(), zones: [] } as never,
      ]);

      await expect(
        generateCertificateEmailAttachments({
          abstractId: "abstract-123456",
          certificateTemplateIds: ["template-123456", "template-999999"],
          imageCache: new Map(),
        }),
      ).rejects.toThrow("no longer active");
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";

// ---------------------------------------------------------------------------
// Mocks — the packages/db fn layer + @app/integrations (storage / context).
// ---------------------------------------------------------------------------

vi.mock("@app/db", () => ({
  listCertificateTemplates: vi.fn(),
  getCertificateTemplateWithEvent: vi.fn(),
  getCertificateTemplateImageState: vi.fn(),
  getCertificateTemplateForDelete: vi.fn(),
  getCertificateTemplateForUpload: vi.fn(),
  createCertificateTemplate: vi.fn(),
  updateCertificateTemplate: vi.fn(),
  updateCertificateTemplateImage: vi.fn(),
  deleteCertificateTemplateById: vi.fn(),
  listActiveImageReadyCertificateTemplates: vi.fn(),
  getRegistrationsForCertificateSend: vi.fn(),
  getAlreadySentCertTemplateIds: vi.fn(),
  getTemplateByTrigger: vi.fn(),
  createEmailLogsBulk: vi.fn(),
  getAbstractsForCertificateSend: vi.fn(),
  getAlreadySentAbstractCertTemplateIds: vi.fn(),
}));

const mockStorageUpload = vi
  .fn()
  .mockResolvedValue("https://storage.example.com/ev1/certificates/tpl1.png");
const mockStorageDelete = vi.fn().mockResolvedValue(undefined);
const mockStorageDownload = vi.fn().mockResolvedValue({
  buffer: Buffer.from("image-bytes"),
  contentType: "image/png",
});

vi.mock("@app/integrations", async (importOriginal) => ({
  // Keep the real extractStorageKeyFromUrl (pure); stub the storage/IO fns.
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: vi.fn(() => ({
    uploadPublic: mockStorageUpload,
    uploadPrivate: vi.fn().mockResolvedValue("private-key"),
    getSignedUrl: vi.fn(),
    delete: mockStorageDelete,
    download: mockStorageDownload,
  })),
  buildEmailContextWithAccess: vi.fn(async () => ({ eventName: "Event" })),
  isEligibleForCertificate: vi.fn(() => true),
}));

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi
    .fn()
    .mockResolvedValue({ ext: "png", mime: "image/png" }),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
  })),
}));

import { fileTypeFromBuffer } from "file-type";
import {
  listCertificateTemplates,
  getCertificateTemplateWithEvent,
  getCertificateTemplateImageState,
  getCertificateTemplateForDelete,
  getCertificateTemplateForUpload,
  createCertificateTemplate,
  updateCertificateTemplate,
  updateCertificateTemplateImage,
  deleteCertificateTemplateById,
  listActiveImageReadyCertificateTemplates,
  getRegistrationsForCertificateSend,
  getAlreadySentCertTemplateIds,
  getTemplateByTrigger,
  createEmailLogsBulk,
  getAbstractsForCertificateSend,
  getAlreadySentAbstractCertTemplateIds,
} from "@app/db";
import { CertificatesService } from "./certificates.service";

const mockFileType = vi.mocked(fileTypeFromBuffer);

const templateId = "tpl-001";
const eventId = "evt-001";

function baseMockTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: templateId,
    eventId,
    name: "Attendance Certificate",
    templateUrl:
      "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
    templateWidth: 1920,
    templateHeight: 1080,
    zones: [],
    applicableRoles: [],
    accessId: null,
    active: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    access: null,
    ...overrides,
  };
}

describe("CertificatesService", () => {
  const service = new CertificatesService();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageDownload.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
    });
  });

  // -------------------------------------------------------------------------
  // listTemplates
  // -------------------------------------------------------------------------
  describe("listTemplates", () => {
    it("returns templates for a given eventId", async () => {
      const templates = [
        baseMockTemplate(),
        baseMockTemplate({ id: "tpl-002", name: "Speaker Certificate" }),
      ];
      vi.mocked(listCertificateTemplates).mockResolvedValue(templates as never);

      const result = await service.listTemplates(eventId);

      expect(result).toHaveLength(2);
      expect(listCertificateTemplates).toHaveBeenCalledWith(eventId);
    });

    it("returns an empty array when no templates exist", async () => {
      vi.mocked(listCertificateTemplates).mockResolvedValue([]);
      const result = await service.listTemplates(eventId);
      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTemplate
  // -------------------------------------------------------------------------
  describe("getTemplate", () => {
    it("returns the template when found", async () => {
      const template = {
        ...baseMockTemplate(),
        event: { clientId: "c1", status: "CLOSED" },
      };
      vi.mocked(getCertificateTemplateWithEvent).mockResolvedValue(
        template as never,
      );

      const result = await service.getTemplate(templateId);

      expect(result.id).toBe(templateId);
      expect(getCertificateTemplateWithEvent).toHaveBeenCalledWith(templateId);
    });

    it("throws 404 AppException when not found", async () => {
      vi.mocked(getCertificateTemplateWithEvent).mockResolvedValue(null);

      await expect(service.getTemplate("nope")).rejects.toBeInstanceOf(
        AppException,
      );
      await expect(service.getTemplate("nope")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  // -------------------------------------------------------------------------
  // createTemplate
  // -------------------------------------------------------------------------
  describe("createTemplate", () => {
    it("creates a template with defaulted applicableRoles/accessId", async () => {
      vi.mocked(createCertificateTemplate).mockResolvedValue(
        baseMockTemplate() as never,
      );

      await service.createTemplate(eventId, {
        name: "Attendance Certificate",
        applicableRoles: [],
      });

      expect(createCertificateTemplate).toHaveBeenCalledWith({
        eventId,
        name: "Attendance Certificate",
        applicableRoles: [],
        accessId: null,
      });
    });

    it("forwards optional applicableRoles and accessId", async () => {
      vi.mocked(createCertificateTemplate).mockResolvedValue(
        baseMockTemplate() as never,
      );

      await service.createTemplate(eventId, {
        name: "Speaker Cert",
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
      });

      expect(createCertificateTemplate).toHaveBeenCalledWith({
        eventId,
        name: "Speaker Cert",
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateTemplate
  // -------------------------------------------------------------------------
  describe("updateTemplate", () => {
    it("updates the name only (no current-state read)", async () => {
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ name: "New Name" }) as never,
      );

      const result = await service.updateTemplate(templateId, {
        name: "New Name",
      });

      expect(result.name).toBe("New Name");
      expect(getCertificateTemplateImageState).not.toHaveBeenCalled();
      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        name: "New Name",
      });
    });

    it("rejects activating a template without an uploaded image", async () => {
      vi.mocked(getCertificateTemplateImageState).mockResolvedValue({
        templateUrl: "",
        accessId: null,
      });

      await expect(
        service.updateTemplate(templateId, { active: true }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
      expect(updateCertificateTemplate).not.toHaveBeenCalled();
    });

    it("allows activating a template that has an image", async () => {
      vi.mocked(getCertificateTemplateImageState).mockResolvedValue({
        templateUrl: "https://storage.googleapis.com/bucket/img.png",
        accessId: null,
      });
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ active: true }) as never,
      );

      const result = await service.updateTemplate(templateId, { active: true });

      expect(result.active).toBe(true);
      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        active: true,
      });
    });

    it("sets accessId to null (unlink)", async () => {
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ accessId: null }) as never,
      );

      await service.updateTemplate(templateId, { accessId: null });

      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        accessId: null,
      });
    });

    it("sets accessId to a new id (link)", async () => {
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ accessId: "new-access" }) as never,
      );

      await service.updateTemplate(templateId, { accessId: "new-access" });

      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        accessId: "new-access",
      });
    });
  });

  // -------------------------------------------------------------------------
  // deleteTemplate
  // -------------------------------------------------------------------------
  describe("deleteTemplate", () => {
    it("deletes a template and its stored image", async () => {
      vi.mocked(getCertificateTemplateForDelete).mockResolvedValue({
        id: templateId,
        templateUrl:
          "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
      });
      vi.mocked(deleteCertificateTemplateById).mockResolvedValue();

      await service.deleteTemplate(templateId);

      expect(mockStorageDelete).toHaveBeenCalled();
      expect(deleteCertificateTemplateById).toHaveBeenCalledWith(templateId);
    });

    it("deletes a template that has no image (no storage delete)", async () => {
      vi.mocked(getCertificateTemplateForDelete).mockResolvedValue({
        id: templateId,
        templateUrl: "",
      });
      vi.mocked(deleteCertificateTemplateById).mockResolvedValue();

      await service.deleteTemplate(templateId);

      expect(mockStorageDelete).not.toHaveBeenCalled();
      expect(deleteCertificateTemplateById).toHaveBeenCalledWith(templateId);
    });

    it("throws 404 AppException when template not found", async () => {
      vi.mocked(getCertificateTemplateForDelete).mockResolvedValue(null);

      await expect(service.deleteTemplate("nope")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("swallows storage delete failures and still deletes the row", async () => {
      vi.mocked(getCertificateTemplateForDelete).mockResolvedValue({
        id: templateId,
        templateUrl:
          "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
      });
      mockStorageDelete.mockRejectedValueOnce(new Error("boom"));
      vi.mocked(deleteCertificateTemplateById).mockResolvedValue();

      await service.deleteTemplate(templateId);

      expect(deleteCertificateTemplateById).toHaveBeenCalledWith(templateId);
    });
  });

  // -------------------------------------------------------------------------
  // uploadTemplateImage
  // -------------------------------------------------------------------------
  describe("uploadTemplateImage", () => {
    const file = {
      buffer: Buffer.from("fake-png-content"),
      filename: "cert.png",
      mimetype: "image/png",
    };

    it("uploads an image and updates dimensions", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" } as never);
      vi.mocked(getCertificateTemplateForUpload).mockResolvedValue({
        id: templateId,
        eventId,
        templateUrl: "",
      });
      vi.mocked(updateCertificateTemplateImage).mockResolvedValue(
        baseMockTemplate({
          templateUrl: "https://storage.example.com/ev1/certificates/tpl1.png",
          templateWidth: 1920,
          templateHeight: 1080,
        }) as never,
      );

      const result = await service.uploadTemplateImage(templateId, file);

      expect(result.templateWidth).toBe(1920);
      expect(result.templateHeight).toBe(1080);
      expect(mockStorageUpload).toHaveBeenCalled();
      expect(updateCertificateTemplateImage).toHaveBeenCalledWith(templateId, {
        templateUrl: "https://storage.example.com/ev1/certificates/tpl1.png",
        templateWidth: 1920,
        templateHeight: 1080,
      });
    });

    it("rejects disallowed MIME types", async () => {
      mockFileType.mockResolvedValue({ ext: "gif", mime: "image/gif" } as never);

      await expect(
        service.uploadTemplateImage(templateId, { ...file, mimetype: "image/gif" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("rejects when file-type detection returns null", async () => {
      mockFileType.mockResolvedValue(undefined as never);

      await expect(
        service.uploadTemplateImage(templateId, file),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("throws 404 when the template does not exist", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" } as never);
      vi.mocked(getCertificateTemplateForUpload).mockResolvedValue(null);

      await expect(
        service.uploadTemplateImage(templateId, file),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("deletes the old image before uploading a new one", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" } as never);
      vi.mocked(getCertificateTemplateForUpload).mockResolvedValue({
        id: templateId,
        eventId,
        templateUrl:
          "https://storage.googleapis.com/bucket/ev1/certificates/old.png",
      });
      vi.mocked(updateCertificateTemplateImage).mockResolvedValue(
        baseMockTemplate() as never,
      );

      await service.uploadTemplateImage(templateId, file);

      expect(mockStorageDelete).toHaveBeenCalled();
      expect(mockStorageUpload).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // downloadTemplateImage
  // -------------------------------------------------------------------------
  describe("downloadTemplateImage", () => {
    it("downloads the image from storage", async () => {
      const result = await service.downloadTemplateImage(
        "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
      );

      expect(result.buffer).toBeDefined();
      expect(mockStorageDownload).toHaveBeenCalled();
    });

    it("throws 400 for an invalid URL", async () => {
      await expect(
        service.downloadTemplateImage("not-a-url"),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("throws 404 when the storage file is missing", async () => {
      mockStorageDownload.mockRejectedValueOnce({ code: 404 });

      await expect(
        service.downloadTemplateImage(
          "https://storage.googleapis.com/bucket/missing.png",
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  // -------------------------------------------------------------------------
  // sendCertificates (orchestration: eligibility → context → dedup → queue)
  // -------------------------------------------------------------------------
  describe("sendCertificates", () => {
    const event = { id: eventId, clientId: "c1" };

    function registration(overrides: Record<string, unknown> = {}) {
      return {
        id: "reg-1",
        email: "a@b.com",
        firstName: "Ada",
        lastName: "Lovelace",
        role: "PARTICIPANT",
        checkedInAt: new Date(),
        accessCheckIns: [],
        eventId,
        event: {
          name: "Event",
          startDate: new Date(),
          location: "Tunis",
          client: { name: "Client", email: "c@x.com", phone: null },
        },
        ...overrides,
      };
    }

    function certTemplate(overrides: Record<string, unknown> = {}) {
      return {
        id: "c1",
        name: "Cert A",
        templateUrl: "url",
        templateWidth: 10,
        templateHeight: 10,
        zones: [],
        applicableRoles: [],
        accessId: null,
        access: null,
        ...overrides,
      };
    }

    it("throws 400 when no CERTIFICATE_SENT template is configured", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue(null);

      await expect(
        service.sendCertificates(event, undefined),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("throws 400 when no active certificate templates exist", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([]);

      await expect(
        service.sendCertificates(event, undefined),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("queues one email per eligible registrant with the dedup key", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);
      vi.mocked(getAlreadySentCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(1);

      const result = await service.sendCertificates(event, undefined);

      expect(result).toEqual({
        success: true,
        queued: 1,
        skipped: 0,
        total: 1,
        breakdown: { "Cert A": 1 },
      });
      expect(createEmailLogsBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          trigger: "CERTIFICATE_SENT",
          templateId: "et1",
          registrationId: "reg-1",
          recipientEmail: "a@b.com",
          recipientName: "Ada Lovelace",
          subject: "",
          status: "QUEUED",
          contextSnapshot: expect.objectContaining({
            certificateCount: "1",
            certificateList: "Cert A",
            _certificateTemplateIds: ["c1"],
          }),
        }),
      ]);
    });

    it("skips a registrant whose eligible templates were all already sent", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);
      vi.mocked(getAlreadySentCertTemplateIds).mockResolvedValue(
        new Map([["reg-1", new Set(["c1"])]]),
      );
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, undefined);

      expect(result.queued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(1);
      expect(createEmailLogsBulk).toHaveBeenCalledWith([]);
    });
  });

  // -------------------------------------------------------------------------
  // sendCertificates — abstract certificates (H2)
  // -------------------------------------------------------------------------
  describe("sendCertificates — abstract certificates (H2)", () => {
    const event = { id: eventId, clientId: "c1" };

    function certTemplate(overrides: Record<string, unknown> = {}) {
      return {
        id: "c1",
        name: "Presenter Certificate",
        templateUrl: "url",
        templateWidth: 10,
        templateHeight: 10,
        zones: [],
        applicableRoles: [],
        accessId: null,
        access: null,
        ...overrides,
      };
    }

    function abstractRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "abs-1",
        eventId,
        status: "ACCEPTED",
        presentedAt: new Date("2026-07-10T00:00:00Z"),
        finalType: "ORAL_COMMUNICATION",
        requestedType: "ORAL_COMMUNICATION",
        code: "OC1-01",
        content: { title: "A Great Abstract" },
        authorFirstName: "Ada",
        authorLastName: "Lovelace",
        authorEmail: "ada@example.com",
        event: { name: "Event", startDate: new Date("2026-07-19"), location: "Tunis" },
        ...overrides,
      };
    }

    // No registrations in play for any of these — isolate the abstract path.
    beforeEach(() => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([]);
    });

    it("omitting abstractIds leaves the response shape untouched (no abstracts key)", async () => {
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, []);

      expect(result.abstracts).toBeUndefined();
      expect(getAbstractsForCertificateSend).not.toHaveBeenCalled();
    });

    it("narrows registrations to none when abstractIds is provided without registrationIds", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      await service.sendCertificates(event, undefined, ["abs-1"]);

      expect(getRegistrationsForCertificateSend).toHaveBeenCalledWith(eventId, []);
    });

    it("reports a not-ACCEPTED abstract as ineligible, per-id, without failing the request", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ status: "SUBMITTED" }) as never,
      ]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts).toMatchObject({
        queued: 0,
        skipped: 1,
        total: 1,
        results: [
          {
            abstractId: "abs-1",
            status: "ineligible",
            reason: "Abstract is not ACCEPTED",
          },
        ],
      });
      expect(createEmailLogsBulk).toHaveBeenCalledWith([]);
    });

    it("reports an ACCEPTED-but-not-presented abstract as ineligible", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ presentedAt: null }) as never,
      ]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts?.results).toEqual([
        {
          abstractId: "abs-1",
          status: "ineligible",
          reason: "Abstract has not been marked as presented",
        },
      ]);
    });

    it("reports an abstract not found for this event as ineligible (wrong event / bad id)", async () => {
      // getAbstractsForCertificateSend is already event-scoped, so a
      // wrong-event/missing id simply never comes back.
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, [], ["missing-abs"]);

      expect(result.abstracts?.results).toEqual([
        {
          abstractId: "missing-abs",
          status: "ineligible",
          reason: "Abstract not found for this event",
        },
      ]);
    });

    it("skips an eligible abstract whose certificate was already sent (dedupe)", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
      ]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(
        new Map([["abs-1", new Set(["c1"])]]),
      );
      vi.mocked(createEmailLogsBulk).mockResolvedValue(0);

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts).toMatchObject({
        queued: 0,
        skipped: 1,
        total: 1,
        results: [{ abstractId: "abs-1", status: "already_sent" }],
      });
      expect(createEmailLogsBulk).toHaveBeenCalledWith([]);
    });

    it("queues exactly one email with certificate + abstract context for the eligible, first-time case", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
      ]);
      vi.mocked(getAlreadySentAbstractCertTemplateIds).mockResolvedValue(new Map());
      vi.mocked(createEmailLogsBulk).mockResolvedValue(1);

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts).toMatchObject({
        queued: 1,
        skipped: 0,
        total: 1,
        results: [{ abstractId: "abs-1", status: "queued" }],
      });
      expect(createEmailLogsBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          trigger: "CERTIFICATE_SENT",
          templateId: "et1",
          abstractId: "abs-1",
          recipientEmail: "ada@example.com",
          recipientName: "Ada Lovelace",
          subject: "",
          status: "QUEUED",
          contextSnapshot: expect.objectContaining({
            _certificateTemplateIds: ["c1"],
            certificateCount: "1",
            certificateList: "Presenter Certificate",
            fullName: "Ada Lovelace",
            abstractTitle: "A Great Abstract",
            abstractCode: "OC1-01",
          }),
        }),
      ]);
    });
  });
});

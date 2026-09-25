import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";

// ---------------------------------------------------------------------------
// Mocks — the packages/db fn layer + @app/integrations (storage / context).
// ---------------------------------------------------------------------------

vi.mock("@app/db", () => ({
  listCertificateTemplates: vi.fn(),
  getCertificateTemplateWithEvent: vi.fn(),
  getCertificateTemplateImageState: vi.fn(),
  findExistingAccessIdsInEvent: vi.fn(),
  getCertificateTemplateForDelete: vi.fn(),
  getCertificateTemplateForUpload: vi.fn(),
  createCertificateTemplate: vi.fn(),
  updateCertificateTemplate: vi.fn(),
  updateCertificateTemplateImage: vi.fn(),
  deleteCertificateTemplateById: vi.fn(),
  listActiveImageReadyCertificateTemplates: vi.fn(),
  getRegistrationsForCertificateSend: vi.fn(),
  getTemplateByTrigger: vi.fn(),
  getAbstractsForCertificateSend: vi.fn(),
  queueCertificateEmailLogsTxn: vi.fn(),
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
  findExistingAccessIdsInEvent,
  getCertificateTemplateForDelete,
  getCertificateTemplateForUpload,
  createCertificateTemplate,
  updateCertificateTemplate,
  updateCertificateTemplateImage,
  deleteCertificateTemplateById,
  listActiveImageReadyCertificateTemplates,
  getRegistrationsForCertificateSend,
  getTemplateByTrigger,
  getAbstractsForCertificateSend,
  queueCertificateEmailLogsTxn,
  type CertificateEmailCandidate,
  type CertificateEmailOutcome,
} from "@app/db";
import { StorageObjectNotFoundError } from "@app/integrations";
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
    vi.mocked(findExistingAccessIdsInEvent).mockImplementation(async (ids) => ids);
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
        scope: "BOTH",
        allowedAbstractFinalTypes: [],
      });

      expect(createCertificateTemplate).toHaveBeenCalledWith({
        eventId,
        name: "Attendance Certificate",
        applicableRoles: [],
        accessId: null,
        scope: "BOTH",
        allowedAbstractFinalTypes: [],
      });
    });

    it("rejects an accessId from another event", async () => {
      vi.mocked(findExistingAccessIdsInEvent).mockResolvedValue([]);

      await expect(
        service.createTemplate(eventId, {
          name: "Speaker Cert",
          applicableRoles: [],
          accessId: "foreign-access",
          scope: "BOTH",
          allowedAbstractFinalTypes: [],
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
      expect(createCertificateTemplate).not.toHaveBeenCalled();
    });

    it("forwards optional applicableRoles and accessId", async () => {
      vi.mocked(createCertificateTemplate).mockResolvedValue(
        baseMockTemplate() as never,
      );

      await service.createTemplate(eventId, {
        name: "Speaker Cert",
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
        scope: "BOTH",
        allowedAbstractFinalTypes: [],
      });

      expect(createCertificateTemplate).toHaveBeenCalledWith({
        eventId,
        name: "Speaker Cert",
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
        scope: "BOTH",
        allowedAbstractFinalTypes: [],
      });
      expect(findExistingAccessIdsInEvent).toHaveBeenCalledWith(
        ["access-001"],
        eventId,
      );
    });

    // H2: scope + allowedAbstractFinalTypes forwarding.
    it("forwards an explicit scope and allowedAbstractFinalTypes", async () => {
      vi.mocked(createCertificateTemplate).mockResolvedValue(
        baseMockTemplate() as never,
      );

      await service.createTemplate(eventId, {
        name: "Presenter Cert",
        applicableRoles: [],
        scope: "ABSTRACT",
        allowedAbstractFinalTypes: ["POSTER"],
      });

      expect(createCertificateTemplate).toHaveBeenCalledWith({
        eventId,
        name: "Presenter Cert",
        applicableRoles: [],
        accessId: null,
        scope: "ABSTRACT",
        allowedAbstractFinalTypes: ["POSTER"],
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
        eventId,
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
        eventId,
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

      expect(getCertificateTemplateImageState).toHaveBeenCalledWith(templateId);
      expect(findExistingAccessIdsInEvent).toHaveBeenCalledWith(
        ["new-access"],
        eventId,
      );
      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        accessId: "new-access",
      });
    });

    it("rejects linking an accessId from another event", async () => {
      vi.mocked(getCertificateTemplateImageState).mockResolvedValue({
        eventId,
        templateUrl: "https://storage.googleapis.com/bucket/img.png",
        accessId: null,
      });
      vi.mocked(findExistingAccessIdsInEvent).mockResolvedValue([]);

      await expect(
        service.updateTemplate(templateId, { accessId: "foreign-access" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
      expect(updateCertificateTemplate).not.toHaveBeenCalled();
    });

    // H2: scope + allowedAbstractFinalTypes patch forwarding.
    it("forwards a scope + allowedAbstractFinalTypes patch", async () => {
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ scope: "ABSTRACT" }) as never,
      );

      await service.updateTemplate(templateId, {
        scope: "ABSTRACT",
        allowedAbstractFinalTypes: ["ORAL_COMMUNICATION"],
      });

      expect(updateCertificateTemplate).toHaveBeenCalledWith(templateId, {
        scope: "ABSTRACT",
        allowedAbstractFinalTypes: ["ORAL_COMMUNICATION"],
      });
    });

    it("omits scope/allowedAbstractFinalTypes from the patch when not provided", async () => {
      vi.mocked(updateCertificateTemplate).mockResolvedValue(
        baseMockTemplate({ name: "New Name" }) as never,
      );

      await service.updateTemplate(templateId, { name: "New Name" });

      const patch = vi.mocked(updateCertificateTemplate).mock.calls[0][1];
      expect(patch).not.toHaveProperty("scope");
      expect(patch).not.toHaveProperty("allowedAbstractFinalTypes");
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

    // ---- write ordering: upload new key → update row → delete old ----------
    describe("write ordering", () => {
      const oldUrl = `https://storage.googleapis.com/bucket/${eventId}/certificates/${templateId}.png`;
      const oldKey = `${eventId}/certificates/${templateId}.png`;
      const uploadedKey = () => mockStorageUpload.mock.calls[0][1] as string;

      beforeEach(() => {
        mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" } as never);
        mockStorageUpload.mockImplementation(
          async (_buffer: Buffer, key: string) => `https://cdn.example.com/${key}`,
        );
        vi.mocked(getCertificateTemplateForUpload).mockResolvedValue({
          id: templateId,
          eventId,
          templateUrl: oldUrl,
        });
        vi.mocked(updateCertificateTemplateImage).mockResolvedValue(
          baseMockTemplate() as never,
        );
      });

      afterEach(() => {
        mockStorageUpload.mockReset();
        mockStorageUpload.mockResolvedValue(
          "https://storage.example.com/ev1/certificates/tpl1.png",
        );
      });

      it("uploads under a fresh key and deletes the old image only after the row update", async () => {
        await service.uploadTemplateImage(templateId, file);

        expect(uploadedKey()).toMatch(
          new RegExp(`^${eventId}/certificates/${templateId}-[0-9a-f-]{36}\\.png$`),
        );
        expect(updateCertificateTemplateImage).toHaveBeenCalledWith(templateId, {
          templateUrl: `https://cdn.example.com/${uploadedKey()}`,
          templateWidth: 1920,
          templateHeight: 1080,
        });
        expect(mockStorageDelete).toHaveBeenCalledTimes(1);
        expect(mockStorageDelete).toHaveBeenCalledWith(oldKey);
        const [uploadOrder] = mockStorageUpload.mock.invocationCallOrder;
        const [updateOrder] = vi.mocked(updateCertificateTemplateImage).mock
          .invocationCallOrder;
        const [deleteOrder] = mockStorageDelete.mock.invocationCallOrder;
        expect(uploadOrder).toBeLessThan(updateOrder);
        expect(updateOrder).toBeLessThan(deleteOrder);
      });

      it("never reuses a key across uploads", async () => {
        await service.uploadTemplateImage(templateId, file);
        await service.uploadTemplateImage(templateId, file);
        const [first, second] = mockStorageUpload.mock.calls.map((c) => c[1]);
        expect(first).not.toBe(second);
      });

      it("row update failure keeps the old image, deletes the new object and rethrows", async () => {
        const dbDown = new Error("db down");
        vi.mocked(updateCertificateTemplateImage).mockRejectedValueOnce(dbDown);

        await expect(service.uploadTemplateImage(templateId, file)).rejects.toBe(dbDown);

        expect(mockStorageDelete).toHaveBeenCalledTimes(1);
        expect(mockStorageDelete).toHaveBeenCalledWith(uploadedKey());
        expect(mockStorageDelete).not.toHaveBeenCalledWith(oldKey);
      });

      it("template deleted during the upload → 404 and the new object is removed", async () => {
        vi.mocked(updateCertificateTemplateImage).mockResolvedValueOnce(null as never);

        await expect(service.uploadTemplateImage(templateId, file)).rejects.toMatchObject({
          statusCode: 404,
          code: ErrorCodes.NOT_FOUND,
        });

        expect(mockStorageDelete).toHaveBeenCalledTimes(1);
        expect(mockStorageDelete).toHaveBeenCalledWith(uploadedKey());
      });

      it("an old-image delete failure does not fail the request", async () => {
        mockStorageDelete.mockRejectedValueOnce(new Error("storage down"));

        await expect(service.uploadTemplateImage(templateId, file)).resolves.toBeDefined();
        expect(mockStorageDelete).toHaveBeenCalledWith(oldKey);
      });

      it("never deletes a stored image outside this event's certificates prefix", async () => {
        vi.mocked(getCertificateTemplateForUpload).mockResolvedValue({
          id: templateId,
          eventId,
          templateUrl: "https://storage.googleapis.com/bucket/evt-999/certificates/x.png",
        });

        await service.uploadTemplateImage(templateId, file);

        expect(updateCertificateTemplateImage).toHaveBeenCalledTimes(1);
        expect(mockStorageDelete).not.toHaveBeenCalled();
      });
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
      mockStorageDownload.mockRejectedValueOnce(
        new StorageObjectNotFoundError("missing.png"),
      );

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
  // -------------------------------------------------------------------------
  // sendCertificates — the queueing transaction is faked: it dedupes each
  // candidate against `sent` (target id → certificate ids) and refuses the
  // targets in `conflicts`, like queueCertificateEmailLogsTxn.
  // -------------------------------------------------------------------------
  function fakeQueue(
    sent: { registrations?: Record<string, string[]>; abstracts?: Record<string, string[]> } = {},
    conflicts: string[] = [],
  ) {
    const outcomeFor =
      (sentByTarget: Record<string, string[]> = {}) =>
      (candidate: CertificateEmailCandidate): CertificateEmailOutcome => {
        const done = new Set(sentByTarget[candidate.targetId] ?? []);
        const remaining = candidate.certificates.filter((c) => !done.has(c.id));
        if (remaining.length === 0) return { status: "already_sent" };
        if (conflicts.includes(candidate.targetId)) return { status: "skipped_conflict" };
        return {
          status: "queued",
          emailLogId: `log-${candidate.targetId}`,
          certificates: remaining.map(({ id, name }) => ({ id, name })),
        };
      };
    vi.mocked(queueCertificateEmailLogsTxn).mockImplementation(async (input) => ({
      registrations: input.registrations.map(outcomeFor(sent.registrations)),
      abstracts: input.abstracts.map(outcomeFor(sent.abstracts)),
    }));
  }

  function queuedInput() {
    const [[input]] = vi.mocked(queueCertificateEmailLogsTxn).mock.calls;
    return input;
  }

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
        scope: "BOTH",
        allowedAbstractFinalTypes: null,
        ...overrides,
      };
    }

    beforeEach(() => fakeQueue());

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

    it("queues one email per eligible registrant through the event-locked transaction", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);

      const result = await service.sendCertificates(event, undefined);

      expect(result).toEqual({
        success: true,
        queued: 1,
        skipped: 0,
        skippedConflict: 0,
        total: 1,
        breakdown: { "Cert A": 1 },
      });
      expect(queueCertificateEmailLogsTxn).toHaveBeenCalledTimes(1);
      expect(queuedInput()).toEqual({
        eventId,
        emailTemplateId: "et1",
        registrations: [
          {
            targetId: "reg-1",
            recipientEmail: "a@b.com",
            recipientName: "Ada Lovelace",
            certificates: [{ id: "c1", name: "Cert A" }],
            contextSnapshot: { eventName: "Event" },
          },
        ],
        abstracts: [],
      });
    });

    it("skips a registrant whose eligible templates were all already sent", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);
      fakeQueue({ registrations: { "reg-1": ["c1"] } });

      const result = await service.sendCertificates(event, undefined);

      expect(result).toMatchObject({
        queued: 0,
        skipped: 1,
        skippedConflict: 0,
        total: 1,
        breakdown: {},
      });
    });

    it("counts only the certificates actually queued in the breakdown", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
        certTemplate({ id: "c2", name: "Cert B" }) as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
        registration({ id: "reg-2", email: "b@b.com" }) as never,
      ]);
      fakeQueue({ registrations: { "reg-1": ["c1"], "reg-2": ["c1", "c2"] } });

      const result = await service.sendCertificates(event, undefined);

      expect(result).toMatchObject({
        queued: 1,
        skipped: 1,
        total: 2,
        breakdown: { "Cert B": 1 },
      });
    });

    it("reports a registrant a unique index refused as skipped (conflict)", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
        registration({ id: "reg-2", email: "b@b.com" }) as never,
      ]);
      fakeQueue({}, ["reg-2"]);

      const result = await service.sendCertificates(event, undefined);

      expect(result).toMatchObject({
        queued: 1,
        skipped: 1,
        skippedConflict: 1,
        total: 2,
        breakdown: { "Cert A": 1 },
      });
    });

    it("returns 404 when the event disappears before the lock", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);
      vi.mocked(queueCertificateEmailLogsTxn).mockResolvedValue(null);

      await expect(service.sendCertificates(event, undefined)).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("queues registrations and abstracts in the same transaction", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue({ id: "et1" } as never);
      vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
        certTemplate() as never,
      ]);
      vi.mocked(getRegistrationsForCertificateSend).mockResolvedValue([
        registration() as never,
      ]);
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        {
          id: "abs-1",
          eventId,
          status: "ACCEPTED",
          presentedAt: new Date(),
          finalType: "POSTER",
          requestedType: "POSTER",
          code: null,
          content: {},
          authorFirstName: "Ada",
          authorLastName: "Lovelace",
          authorEmail: "a@b.com",
          event: { name: "Event", startDate: new Date(), location: null },
        } as never,
      ]);

      const result = await service.sendCertificates(event, ["reg-1"], ["abs-1"]);

      expect(queueCertificateEmailLogsTxn).toHaveBeenCalledTimes(1);
      expect(queuedInput().registrations.map((c) => c.targetId)).toEqual(["reg-1"]);
      expect(queuedInput().abstracts.map((c) => c.targetId)).toEqual(["abs-1"]);
      expect(result.queued).toBe(1);
      expect(result.abstracts?.results).toEqual([{ abstractId: "abs-1", status: "queued" }]);
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
        scope: "BOTH",
        allowedAbstractFinalTypes: null,
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
      fakeQueue();
    });

    it("omitting abstractIds leaves the response shape untouched (no abstracts key)", async () => {
      const result = await service.sendCertificates(event, []);

      expect(result.abstracts).toBeUndefined();
      expect(getAbstractsForCertificateSend).not.toHaveBeenCalled();
    });

    it("narrows registrations to none when abstractIds is provided without registrationIds", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([]);

      await service.sendCertificates(event, undefined, ["abs-1"]);

      expect(getRegistrationsForCertificateSend).toHaveBeenCalledWith(eventId, []);
    });

    it("reports a not-ACCEPTED abstract as ineligible, per-id, without failing the request", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ status: "SUBMITTED" }) as never,
      ]);

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
      expect(queuedInput().abstracts).toEqual([]);
    });

    it("reports an ACCEPTED-but-not-presented abstract as ineligible", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ presentedAt: null }) as never,
      ]);

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
      fakeQueue({ abstracts: { "abs-1": ["c1"] } });

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts).toMatchObject({
        queued: 0,
        skipped: 1,
        total: 1,
        results: [{ abstractId: "abs-1", status: "already_sent" }],
      });
    });

    it("reports skipped_conflict per abstract when a unique index refuses its email", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
        abstractRow({ id: "abs-2" }) as never,
      ]);
      fakeQueue({}, ["abs-2"]);

      const result = await service.sendCertificates(event, [], ["abs-1", "abs-2"]);

      expect(result.abstracts).toEqual({
        queued: 1,
        skipped: 1,
        total: 2,
        results: [
          { abstractId: "abs-1", status: "queued" },
          { abstractId: "abs-2", status: "skipped_conflict" },
        ],
      });
    });

    it("keeps the input order across ineligible and queued abstracts", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
        abstractRow({ id: "abs-3" }) as never,
      ]);

      const result = await service.sendCertificates(event, [], ["abs-1", "missing", "abs-3", "abs-1"]);

      expect(result.abstracts?.results.map((r) => [r.abstractId, r.status])).toEqual([
        ["abs-1", "queued"],
        ["missing", "ineligible"],
        ["abs-3", "queued"],
      ]);
      expect(queuedInput().abstracts.map((c) => c.targetId)).toEqual(["abs-1", "abs-3"]);
    });

    it("gives an author with two abstracts one email per abstract", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
        abstractRow({ id: "abs-2", content: { title: "Second" } }) as never,
      ]);

      const result = await service.sendCertificates(event, [], ["abs-1", "abs-2"]);

      expect(result.abstracts).toMatchObject({ queued: 2, skipped: 0, total: 2 });
      expect(
        queuedInput().abstracts.map((c) => [c.targetId, c.recipientEmail, c.contextSnapshot.abstractTitle]),
      ).toEqual([
        ["abs-1", "ada@example.com", "A Great Abstract"],
        ["abs-2", "ada@example.com", "Second"],
      ]);
    });

    it("queues exactly one email with certificate + abstract context for the eligible, first-time case", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow() as never,
      ]);

      const result = await service.sendCertificates(event, [], ["abs-1"]);

      expect(result.abstracts).toMatchObject({
        queued: 1,
        skipped: 0,
        total: 1,
        results: [{ abstractId: "abs-1", status: "queued" }],
      });
      expect(queuedInput().abstracts).toEqual([
        {
          targetId: "abs-1",
          recipientEmail: "ada@example.com",
          recipientName: "Ada Lovelace",
          certificates: [{ id: "c1", name: "Presenter Certificate" }],
          contextSnapshot: expect.objectContaining({
            fullName: "Ada Lovelace",
            abstractTitle: "A Great Abstract",
            abstractCode: "OC1-01",
          }),
        },
      ]);
    });

    // H2: {{abstractFinalType}} resolves to the label, not the raw enum.
    it("resolves abstractFinalType to its label in the email context (not the raw enum)", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ finalType: "ORAL_COMMUNICATION" }) as never,
      ]);

      await service.sendCertificates(event, [], ["abs-1"]);

      const [candidate] = queuedInput().abstracts;
      expect(candidate.contextSnapshot).toMatchObject({
        abstractFinalType: "Oral Communication",
      });
      expect(candidate.contextSnapshot).not.toHaveProperty("abstractFinalTypeLabel");
    });

    it("labels a not-yet-finalized abstract by its requestedType", async () => {
      vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
        abstractRow({ finalType: null, requestedType: "POSTER" }) as never,
      ]);

      await service.sendCertificates(event, [], ["abs-1"]);

      expect(queuedInput().abstracts[0].contextSnapshot).toMatchObject({
        abstractFinalType: "Poster",
      });
    });

    // H2: certificate template scope + allowedAbstractFinalTypes gating.
    describe("template scope + allowedAbstractFinalTypes gating", () => {
      it("excludes a REGISTRATION-only-scoped template from the abstract send (no applicable templates)", async () => {
        vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
          certTemplate({ scope: "REGISTRATION" }) as never,
        ]);
        vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
          abstractRow() as never,
        ]);

        const result = await service.sendCertificates(event, [], ["abs-1"]);

        expect(result.abstracts).toMatchObject({
          queued: 0,
          skipped: 1,
          total: 1,
          results: [
            {
              abstractId: "abs-1",
              status: "ineligible",
              reason: "No certificate templates apply to this abstract",
            },
          ],
        });
        expect(queuedInput().abstracts).toEqual([]);
      });

      it("includes an ABSTRACT-scoped template in the abstract send", async () => {
        vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
          certTemplate({ scope: "ABSTRACT" }) as never,
        ]);
        vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
          abstractRow() as never,
        ]);

        const result = await service.sendCertificates(event, [], ["abs-1"]);

        expect(result.abstracts).toMatchObject({
          queued: 1,
          results: [{ abstractId: "abs-1", status: "queued" }],
        });
      });

      it("excludes a template whose allowedAbstractFinalTypes doesn't include the abstract's finalType", async () => {
        vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
          certTemplate({ allowedAbstractFinalTypes: ["POSTER"] }) as never,
        ]);
        vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
          abstractRow({ finalType: "ORAL_COMMUNICATION" }) as never,
        ]);

        const result = await service.sendCertificates(event, [], ["abs-1"]);

        expect(result.abstracts).toMatchObject({
          queued: 0,
          results: [{ abstractId: "abs-1", status: "ineligible" }],
        });
      });

      it("includes a template whose allowedAbstractFinalTypes includes the abstract's finalType", async () => {
        vi.mocked(listActiveImageReadyCertificateTemplates).mockResolvedValue([
          certTemplate({ allowedAbstractFinalTypes: ["ORAL_COMMUNICATION"] }) as never,
        ]);
        vi.mocked(getAbstractsForCertificateSend).mockResolvedValue([
          abstractRow({ finalType: "ORAL_COMMUNICATION" }) as never,
        ]);

        const result = await service.sendCertificates(event, [], ["abs-1"]);

        expect(result.abstracts).toMatchObject({
          queued: 1,
          results: [{ abstractId: "abs-1", status: "queued" }],
        });
      });
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { fileTypeFromBuffer } from "file-type";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
  downloadTemplateImage,
} from "./certificates.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStorageUpload = vi
  .fn()
  .mockResolvedValue("https://storage.example.com/ev1/certificates/tpl1.png");
const mockStorageDelete = vi.fn().mockResolvedValue(undefined);
const mockStorageDownload = vi.fn().mockResolvedValue({
  buffer: Buffer.from("image-bytes"),
  contentType: "image/png",
});

vi.mock("@shared/services/storage/index.js", () => ({
  getStorageProvider: vi.fn(() => ({
    upload: mockStorageUpload,
    delete: mockStorageDelete,
    download: mockStorageDownload,
  })),
}));

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi
    .fn()
    .mockResolvedValue({ ext: "png", mime: "image/png" }),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    metadata: vi
      .fn()
      .mockResolvedValue({ width: 1920, height: 1080 }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const templateId = "tpl-001";
const eventId = "evt-001";
const mockFileType = vi.mocked(fileTypeFromBuffer);

function baseMockTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: templateId,
    eventId,
    name: "Attendance Certificate",
    templateUrl: "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Certificates Service", () => {
  // -------------------------------------------------------------------------
  // listTemplates
  // -------------------------------------------------------------------------

  describe("listTemplates", () => {
    it("should return templates for a given eventId", async () => {
      const templates = [baseMockTemplate(), baseMockTemplate({ id: "tpl-002", name: "Speaker Certificate" })];
      prismaMock.certificateTemplate.findMany.mockResolvedValue(templates as never);

      const result = await listTemplates(eventId);

      expect(result).toHaveLength(2);
      expect(prismaMock.certificateTemplate.findMany).toHaveBeenCalledWith({
        where: { eventId },
        include: { access: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should return an empty array when no templates exist", async () => {
      prismaMock.certificateTemplate.findMany.mockResolvedValue([]);

      const result = await listTemplates(eventId);

      expect(result).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTemplate
  // -------------------------------------------------------------------------

  describe("getTemplate", () => {
    it("should return the template when found", async () => {
      const template = { ...baseMockTemplate(), event: { clientId: "c1" } };
      prismaMock.certificateTemplate.findUnique.mockResolvedValue(template as never);

      const result = await getTemplate(templateId);

      expect(result.id).toBe(templateId);
      expect(prismaMock.certificateTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: templateId },
        include: {
          access: { select: { id: true, name: true, type: true } },
          event: { select: { clientId: true } },
        },
      });
    });

    it("should throw 404 AppError when not found", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue(null);

      await expect(getTemplate("nonexistent")).rejects.toThrow(AppError);
      await expect(getTemplate("nonexistent")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  // -------------------------------------------------------------------------
  // createTemplate
  // -------------------------------------------------------------------------

  describe("createTemplate", () => {
    it("should create a template with required fields", async () => {
      const created = baseMockTemplate();
      prismaMock.certificateTemplate.create.mockResolvedValue(created as never);

      const result = await createTemplate(eventId, { name: "Attendance Certificate", applicableRoles: [] });

      expect(result.name).toBe("Attendance Certificate");
      expect(prismaMock.certificateTemplate.create).toHaveBeenCalledWith({
        data: {
          eventId,
          name: "Attendance Certificate",
          templateUrl: "",
          templateWidth: 0,
          templateHeight: 0,
          applicableRoles: [],
          accessId: null,
        },
        include: { access: { select: { id: true, name: true, type: true } } },
      });
    });

    it("should forward optional applicableRoles and accessId", async () => {
      const created = baseMockTemplate({
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
      });
      prismaMock.certificateTemplate.create.mockResolvedValue(created as never);

      await createTemplate(eventId, {
        name: "Speaker Cert",
        applicableRoles: ["PARTICIPANT"],
        accessId: "access-001",
      });

      expect(prismaMock.certificateTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            applicableRoles: ["PARTICIPANT"],
            accessId: "access-001",
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // updateTemplate
  // -------------------------------------------------------------------------

  describe("updateTemplate", () => {
    it("should update the name", async () => {
      const updated = baseMockTemplate({ name: "New Name" });
      prismaMock.certificateTemplate.update.mockResolvedValue(updated as never);

      const result = await updateTemplate(templateId, { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(prismaMock.certificateTemplate.update).toHaveBeenCalledWith({
        where: { id: templateId },
        data: { name: "New Name" },
        include: { access: { select: { id: true, name: true, type: true } } },
      });
    });

    it("should reject activating a template without an uploaded image", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        templateUrl: "",
        accessId: null,
      } as never);

      await expect(
        updateTemplate(templateId, { active: true }),
      ).rejects.toThrow(AppError);

      await expect(
        updateTemplate(templateId, { active: true }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should allow activating a template that has an image", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        templateUrl: "https://storage.googleapis.com/bucket/img.png",
        accessId: null,
      } as never);
      prismaMock.certificateTemplate.update.mockResolvedValue(
        baseMockTemplate({ active: true }) as never,
      );

      const result = await updateTemplate(templateId, { active: true });

      expect(result.active).toBe(true);
    });

    it("should disconnect access when accessId is set to null", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        templateUrl: "",
        accessId: "existing-access",
      } as never);
      prismaMock.certificateTemplate.update.mockResolvedValue(
        baseMockTemplate({ accessId: null }) as never,
      );

      await updateTemplate(templateId, { accessId: null });

      expect(prismaMock.certificateTemplate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            access: { disconnect: true },
          }),
        }),
      );
    });

    it("should connect access when accessId is provided", async () => {
      prismaMock.certificateTemplate.update.mockResolvedValue(
        baseMockTemplate({ accessId: "new-access" }) as never,
      );

      await updateTemplate(templateId, { accessId: "new-access" });

      expect(prismaMock.certificateTemplate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            access: { connect: { id: "new-access" } },
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // deleteTemplate
  // -------------------------------------------------------------------------

  describe("deleteTemplate", () => {
    it("should delete a template and its stored image", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        id: templateId,
        templateUrl: "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
      } as never);
      prismaMock.certificateTemplate.delete.mockResolvedValue(undefined as never);

      await deleteTemplate(templateId);

      expect(mockStorageDelete).toHaveBeenCalled();
      expect(prismaMock.certificateTemplate.delete).toHaveBeenCalledWith({
        where: { id: templateId },
      });
    });

    it("should delete a template that has no image", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        id: templateId,
        templateUrl: "",
      } as never);
      prismaMock.certificateTemplate.delete.mockResolvedValue(undefined as never);

      await deleteTemplate(templateId);

      expect(mockStorageDelete).not.toHaveBeenCalled();
      expect(prismaMock.certificateTemplate.delete).toHaveBeenCalledWith({
        where: { id: templateId },
      });
    });

    it("should throw 404 AppError when template not found", async () => {
      prismaMock.certificateTemplate.findUnique.mockResolvedValue(null);

      await expect(deleteTemplate("nonexistent")).rejects.toThrow(AppError);
      await expect(deleteTemplate("nonexistent")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
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

    it("should upload an image and update dimensions", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" });

      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        id: templateId,
        eventId,
        templateUrl: "",
      } as never);

      const updated = baseMockTemplate({
        templateUrl: "https://storage.example.com/ev1/certificates/tpl1.png",
        templateWidth: 1920,
        templateHeight: 1080,
      });
      prismaMock.certificateTemplate.update.mockResolvedValue(updated as never);

      const result = await uploadTemplateImage(templateId, file);

      expect(result.templateWidth).toBe(1920);
      expect(result.templateHeight).toBe(1080);
      expect(mockStorageUpload).toHaveBeenCalled();
    });

    it("should reject disallowed MIME types", async () => {
      mockFileType.mockResolvedValue({ ext: "gif", mime: "image/gif" });

      await expect(
        uploadTemplateImage(templateId, {
          ...file,
          mimetype: "image/gif",
        }),
      ).rejects.toThrow(AppError);

      await expect(
        uploadTemplateImage(templateId, {
          ...file,
          mimetype: "image/gif",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should reject when file-type detection returns null", async () => {
      mockFileType.mockResolvedValue(undefined);

      await expect(
        uploadTemplateImage(templateId, file),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should throw 404 when template does not exist", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" });

      prismaMock.certificateTemplate.findUnique.mockResolvedValue(null);

      await expect(
        uploadTemplateImage(templateId, file),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should delete the old image before uploading a new one", async () => {
      mockFileType.mockResolvedValue({ ext: "png", mime: "image/png" });

      prismaMock.certificateTemplate.findUnique.mockResolvedValue({
        id: templateId,
        eventId,
        templateUrl: "https://storage.googleapis.com/bucket/ev1/certificates/old.png",
      } as never);
      prismaMock.certificateTemplate.update.mockResolvedValue(
        baseMockTemplate() as never,
      );

      await uploadTemplateImage(templateId, file);

      expect(mockStorageDelete).toHaveBeenCalled();
      expect(mockStorageUpload).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // downloadTemplateImage
  // -------------------------------------------------------------------------

  describe("downloadTemplateImage", () => {
    it("should download the image from storage", async () => {
      const result = await downloadTemplateImage(
        "https://storage.googleapis.com/bucket/ev1/certificates/tpl1.png",
      );

      expect(result.buffer).toBeDefined();
      expect(mockStorageDownload).toHaveBeenCalled();
    });

    it("should throw 400 for an invalid URL", async () => {
      await expect(
        downloadTemplateImage("not-a-url"),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should throw 404 when the storage file is missing", async () => {
      mockStorageDownload.mockRejectedValueOnce({ code: 404 });

      await expect(
        downloadTemplateImage(
          "https://storage.googleapis.com/bucket/missing.png",
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });
});

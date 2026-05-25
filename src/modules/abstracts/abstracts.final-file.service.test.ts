/* eslint-disable @typescript-eslint/no-explicit-any */
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { AbstractStatus } from "@/generated/prisma/client.js";

const uploadPrivate = vi.fn();
const deleteFile = vi.fn();

vi.mock("@shared/services/storage/index.js", () => ({
  getStorageProvider: () => ({
    uploadPrivate,
    delete: deleteFile,
  }),
}));
vi.mock("@shared/utils/audit.js", () => ({ auditLog: vi.fn() }));
vi.mock("./abstracts.service.js", () => ({
  getAbstractByToken: vi.fn(async () => ({
    id: "abstract-1",
    status: "ACCEPTED",
    finalFile: { uploaded: true, kind: "PDF", size: 128, uploadedAt: "now" },
  })),
}));

import { uploadAbstractFinalFile } from "./abstracts.final-file.service.js";

const abstractId = "abstract-1";
const eventId = "event-1";
const token = "a".repeat(64);

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId,
    editToken: token,
    status: AbstractStatus.ACCEPTED,
    finalType: "POSTER",
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    event: {
      abstractConfig: {
        finalFileUploadEnabled: true,
        finalFileDeadline: null,
      },
    },
    ...overrides,
  };
}

function pdfBuffer() {
  return Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n%%EOF");
}

async function pptxBuffer() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types></Types>");
  zip.file("ppt/presentation.xml", "<presentation></presentation>");
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

beforeEach(() => {
  uploadPrivate.mockReset();
  deleteFile.mockReset();
});

describe("abstracts final file service", () => {
  it("uploads an accepted poster PDF and stores final file metadata", async () => {
    prismaMock.abstract.findUnique.mockResolvedValue(makeAbstract() as any);
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock));
    uploadPrivate.mockResolvedValue(`${eventId}/abstracts/${abstractId}/final.pdf`);

    const result = await uploadAbstractFinalFile(abstractId, token, {
      buffer: pdfBuffer(),
      filename: "poster.pdf",
      mimetype: "application/pdf",
    });

    expect(uploadPrivate).toHaveBeenCalledWith(
      expect.any(Buffer),
      `${eventId}/abstracts/${abstractId}/final.pdf`,
      "application/pdf",
      { contentDisposition: 'attachment; filename="abstract-final.pdf"' },
    );
    expect(prismaMock.abstract.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: abstractId },
      data: expect.objectContaining({
        finalFileKey: `${eventId}/abstracts/${abstractId}/final.pdf`,
        finalFileKind: "PDF",
        finalFileSize: expect.any(Number),
        finalFileUploadedAt: expect.any(Date),
      }),
    }));
    expect(result).toMatchObject({ finalFile: { uploaded: true } });
  });

  it("rejects non-PDF final files for posters", async () => {
    prismaMock.abstract.findUnique.mockResolvedValue(makeAbstract() as any);

    await expect(
      uploadAbstractFinalFile(abstractId, token, {
        buffer: await pptxBuffer(),
        filename: "poster.pptx",
        mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("blocks uploads after final file deadline", async () => {
    prismaMock.abstract.findUnique.mockResolvedValue(
      makeAbstract({
        event: {
          abstractConfig: {
            finalFileUploadEnabled: true,
            finalFileDeadline: new Date("2020-01-01T00:00:00.000Z"),
          },
        },
      }) as any,
    );

    await expect(
      uploadAbstractFinalFile(abstractId, token, {
        buffer: pdfBuffer(),
        filename: "poster.pdf",
        mimetype: "application/pdf",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(uploadPrivate).not.toHaveBeenCalled();
  });
});

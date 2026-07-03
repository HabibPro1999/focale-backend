import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";

const uploadPrivate = vi.fn();
const deleteFile = vi.fn();

vi.mock("@app/db", () => ({
  findAbstractForFinalFile: vi.fn(),
  updateAbstractFinalFileTxn: vi.fn(),
}));
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => ({
    uploadPrivate,
    delete: deleteFile,
    getSignedUrl: vi.fn(),
  }),
}));

import { findAbstractForFinalFile, updateAbstractFinalFileTxn } from "@app/db";
import { AbstractsFinalFileService } from "./abstracts.final-file.service";
import type { AbstractsService } from "./abstracts.service";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const abstractId = "abstract-1";
const eventId = "event-1";
const token = "a".repeat(64);

const stubAbstracts = {
  getAbstractByToken: vi.fn(async () => ({
    id: abstractId,
    finalFile: { uploaded: true, kind: "PDF", size: 128, uploadedAt: "now" },
  })),
} as unknown as AbstractsService;

const service = new AbstractsFinalFileService(stubAbstracts);

function makeAbstract(overrides: Record<string, unknown> = {}) {
  return {
    id: abstractId,
    eventId,
    editToken: token,
    status: "ACCEPTED",
    finalType: "POSTER",
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    config: { finalFileUploadEnabled: true, finalFileDeadline: null },
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
  vi.clearAllMocks();
});

describe("uploadAbstractFinalFile", () => {
  it("uploads an accepted poster PDF and stores metadata", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    uploadPrivate.mockResolvedValue(`${eventId}/abstracts/${abstractId}/final.pdf`);

    const result = await service.uploadAbstractFinalFile(abstractId, token, {
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
    expect(updateAbstractFinalFileTxn).toHaveBeenCalledWith(
      abstractId,
      expect.objectContaining({
        finalFileKey: `${eventId}/abstracts/${abstractId}/final.pdf`,
        finalFileKind: "PDF",
        finalFileSize: expect.any(Number),
        finalFileUploadedAt: expect.any(Date),
      }),
      expect.objectContaining({ action: "final_file_upload", performedBy: "PUBLIC" }),
    );
    expect(result).toMatchObject({ finalFile: { uploaded: true } });
  });

  it("rejects a non-PDF (PPTX) final file for a poster (400, no upload)", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    await expect(
      service.uploadAbstractFinalFile(abstractId, token, {
        buffer: await pptxBuffer(),
        filename: "poster.pptx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("blocks uploads after the final-file deadline (409, no upload)", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({
        config: {
          finalFileUploadEnabled: true,
          finalFileDeadline: new Date("2020-01-01T00:00:00.000Z"),
        },
      }),
    );
    await expect(
      service.uploadAbstractFinalFile(abstractId, token, {
        buffer: pdfBuffer(),
        filename: "poster.pdf",
        mimetype: "application/pdf",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });
});

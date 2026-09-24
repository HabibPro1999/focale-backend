import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";

const uploadPrivate = vi.fn();
const deleteFile = vi.fn();

vi.mock("@app/db", () => ({
  findAbstractForFinalFile: vi.fn(),
  updateAbstractFinalFileTxn: vi.fn(),
  findEventClientId: vi.fn(),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  // Keep the real ownedStorageKey (pure); stub storage IO.
  ...(await importOriginal<Record<string, unknown>>()),
  getStorageProvider: () => ({
    uploadPrivate,
    delete: deleteFile,
    getSignedUrl: vi.fn(),
  }),
}));
vi.mock("../clients/module-gates", () => ({
  assertClientModuleEnabled: vi.fn(),
}));

import {
  findAbstractForFinalFile,
  updateAbstractFinalFileTxn,
  findEventClientId,
} from "@app/db";
import { assertClientModuleEnabled } from "../clients/module-gates";
import {
  AbstractsFinalFileService,
  type FinalFileInput,
} from "./abstracts.final-file.service";
import type { AbstractsService } from "./abstracts.service";
import { AppException } from "../../core/app-exception";
import { ErrorCodes } from "@app/contracts";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const abstractId = "abstract-1";
const eventId = "event-1";
const clientId = "client-1";
const token = "a".repeat(64);
const prefix = `${eventId}/abstracts/${abstractId}`;
const oldKey = `${prefix}/final.pdf`;
const newKeyPattern = new RegExp(
  `^${prefix}/final-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`,
);

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

const pdfFile = (): FinalFileInput => ({
  buffer: pdfBuffer(),
  filename: "poster.pdf",
  mimetype: "application/pdf",
});

/** Returns a reader spy so tests can assert whether the body was ever read. */
function reader(file: FinalFileInput | (() => Promise<FinalFileInput>) = pdfFile()) {
  return vi.fn(typeof file === "function" ? file : async () => file);
}

// The row the locked write-time read returns; defaults to the gate row.
let lockedRow: ReturnType<typeof makeAbstract> | null;
let writes: Array<{ fields: Record<string, unknown>; audit: Record<string, unknown> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mock(findEventClientId).mockResolvedValue({ id: eventId, clientId });
  uploadPrivate.mockImplementation(async (_buffer: Buffer, key: string) => key);
  deleteFile.mockResolvedValue(undefined);
  lockedRow = null;
  writes = [];
  mock(updateAbstractFinalFileTxn).mockImplementation(
    async (
      _id: string,
      prepare: (row: unknown) => {
        fields: Record<string, unknown>;
        audit: Record<string, unknown>;
      },
    ) => {
      const current = lockedRow ?? (await mock(findAbstractForFinalFile)());
      writes.push(prepare(current));
      return { previousKey: current?.finalFileKey ?? null };
    },
  );
});

describe("uploadAbstractFinalFile", () => {
  it("uploads an accepted poster PDF under a fresh key and stores metadata", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());

    const result = await service.uploadAbstractFinalFile(abstractId, token, reader());

    expect(uploadPrivate).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(newKeyPattern),
      "application/pdf",
      { contentDisposition: 'attachment; filename="abstract-final.pdf"' },
    );
    const storedKey = uploadPrivate.mock.calls[0][1] as string;
    expect(writes).toHaveLength(1);
    expect(writes[0].fields).toMatchObject({
      finalFileKey: storedKey,
      finalFileKind: "PDF",
      finalFileSize: expect.any(Number),
      finalFileUploadedAt: expect.any(Date),
    });
    expect(writes[0].audit).toMatchObject({
      action: "final_file_upload",
      performedBy: "PUBLIC",
      changes: { finalFileKey: { old: null, new: storedKey } },
    });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ finalFile: { uploaded: true } });
  });

  it("never reuses a key: two uploads get distinct object keys", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    await service.uploadAbstractFinalFile(abstractId, token, reader());
    await service.uploadAbstractFinalFile(abstractId, token, reader());
    const [first, second] = uploadPrivate.mock.calls.map((call) => call[1]);
    expect(first).toMatch(newKeyPattern);
    expect(second).toMatch(newKeyPattern);
    expect(first).not.toBe(second);
  });

  it("rejects a non-PDF (PPTX) final file for a poster (400, no upload)", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    await expect(
      service.uploadAbstractFinalFile(
        abstractId,
        token,
        reader({
          buffer: await pptxBuffer(),
          filename: "poster.pptx",
          mimetype:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("blocks uploads after the final-file deadline (409) without reading the body", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({
        config: {
          finalFileUploadEnabled: true,
          finalFileDeadline: new Date("2020-01-01T00:00:00.000Z"),
        },
      }),
    );
    const readFile = reader();
    await expect(
      service.uploadAbstractFinalFile(abstractId, token, readFile),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFile).not.toHaveBeenCalled();
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  // H1: CONFERENCE must be accepted like ORAL_COMMUNICATION, not blocked by
  // the "finalType not set" message.
  it("accepts a PPTX final file for a CONFERENCE abstract", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({ finalType: "CONFERENCE" }),
    );

    const result = await service.uploadAbstractFinalFile(
      abstractId,
      token,
      reader({
        buffer: await pptxBuffer(),
        filename: "slides.pptx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    expect(uploadPrivate.mock.calls[0][1]).toMatch(
      new RegExp(`^${prefix}/final-[0-9a-f-]{36}\\.pptx$`),
    );
    expect(result).toMatchObject({ finalFile: { uploaded: true } });
  });

  it("H1: distinguishes 'no finalType yet' (409) from a disallowed kind for a set finalType (400)", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({ finalType: null }),
    );
    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("has not been set"),
    });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("M2: propagates the client module gate rejection without reading the body", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    mock(assertClientModuleEnabled).mockRejectedValueOnce(
      new AppException(ErrorCodes.FORBIDDEN, "Abstracts module is disabled", 403),
    );
    const readFile = reader();
    await expect(
      service.uploadAbstractFinalFile(abstractId, token, readFile),
    ).rejects.toMatchObject({ status: 403 });
    expect(readFile).not.toHaveBeenCalled();
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("rejects an oversized buffer with 413 FILE_TOO_LARGE (defence in depth)", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
    await expect(
      service.uploadAbstractFinalFile(
        abstractId,
        token,
        reader({ ...pdfFile(), buffer: Buffer.alloc(50 * 1024 * 1024 + 1) }),
      ),
    ).rejects.toMatchObject({ status: 413, code: ErrorCodes.FILE_TOO_LARGE });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });
});

describe("uploadAbstractFinalFile — write ordering (upload new → update row → delete old)", () => {
  it("deletes the previous object only after the row update succeeded", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));

    await service.uploadAbstractFinalFile(abstractId, token, reader());

    const storedKey = uploadPrivate.mock.calls[0][1] as string;
    expect(storedKey).not.toBe(oldKey);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(oldKey);
    const [uploadOrder] = uploadPrivate.mock.invocationCallOrder;
    const [updateOrder] = mock(updateAbstractFinalFileTxn).mock.invocationCallOrder;
    const [deleteOrder] = deleteFile.mock.invocationCallOrder;
    expect(uploadOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(deleteOrder);
    expect(writes[0].audit).toMatchObject({
      changes: { finalFileKey: { old: oldKey, new: storedKey } },
    });
  });

  it("deletes the key the locked row actually held, not the one seen at the gate", async () => {
    const racedKey = `${prefix}/final-11111111-1111-4111-8111-111111111111.pdf`;
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    lockedRow = makeAbstract({ finalFileKey: racedKey });

    await service.uploadAbstractFinalFile(abstractId, token, reader());

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(racedKey);
  });

  it("row update failure keeps the old object, deletes the new one and rethrows", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    const dbDown = new Error("db down");
    mock(updateAbstractFinalFileTxn).mockRejectedValueOnce(dbDown);

    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).rejects.toBe(dbDown);

    const storedKey = uploadPrivate.mock.calls[0][1] as string;
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(storedKey);
    expect(deleteFile).not.toHaveBeenCalledWith(oldKey);
  });

  it("status changed during the upload → write-time guard 409, new object removed, old kept", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    lockedRow = makeAbstract({ finalFileKey: oldKey, status: "REJECTED" });

    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).rejects.toMatchObject({ status: 409, code: ErrorCodes.INVALID_STATUS_TRANSITION });

    const storedKey = uploadPrivate.mock.calls[0][1] as string;
    expect(writes).toHaveLength(0);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(storedKey);
  });

  it("window closed during the upload → write-time guard 409, new object removed", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    lockedRow = makeAbstract({
      finalFileKey: oldKey,
      config: { finalFileUploadEnabled: false, finalFileDeadline: null },
    });

    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).rejects.toMatchObject({ status: 409 });

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(uploadPrivate.mock.calls[0][1]);
  });

  it("module disabled during the upload → 403, new object removed, row untouched", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    mock(assertClientModuleEnabled)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new AppException(ErrorCodes.FORBIDDEN, "Abstracts module is disabled", 403),
      );

    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).rejects.toMatchObject({ status: 403 });

    expect(updateAbstractFinalFileTxn).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith(uploadPrivate.mock.calls[0][1]);
    expect(deleteFile).not.toHaveBeenCalledWith(oldKey);
  });

  it("an old-object delete failure is logged, not surfaced", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ finalFileKey: oldKey }));
    deleteFile.mockRejectedValueOnce(new Error("storage down"));

    await expect(
      service.uploadAbstractFinalFile(abstractId, token, reader()),
    ).resolves.toMatchObject({ finalFile: { uploaded: true } });
    expect(deleteFile).toHaveBeenCalledWith(oldKey);
  });

  it("never deletes a previous key outside this abstract's prefix", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({ finalFileKey: `${eventId}/abstracts/other-abstract/final.pdf` }),
    );

    await service.uploadAbstractFinalFile(abstractId, token, reader());

    expect(writes).toHaveLength(1);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

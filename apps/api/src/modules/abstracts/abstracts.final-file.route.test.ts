import { describe, it, expect, beforeEach, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";

// Route-level proof for 0.3: the anonymous final-file route runs every check
// that needs no file (token, abstract, module gate, status, upload window,
// declared size) BEFORE touching the multipart body, so a rejected caller never
// gets up to 50MB buffered. Real controller + real service; only IO is mocked.

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
  getStorageProvider: () => ({ uploadPrivate, delete: deleteFile }),
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
import { AppException } from "../../core/app-exception";
import { AbstractsPublicController } from "./abstracts.public.controller";
import {
  AbstractsFinalFileService,
  MAX_FINAL_FILE_SIZE,
  MULTIPART_OVERHEAD_BYTES,
} from "./abstracts.final-file.service";
import type { AbstractsService } from "./abstracts.service";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const abstractId = "abstract-1";
const eventId = "event-1";
const token = "a".repeat(64);

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

const pdf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n%%EOF");

function multipartRequest(
  opts: {
    headers?: Record<string, string>;
    toBuffer?: () => Promise<Buffer>;
    noFile?: boolean;
  } = {},
) {
  const file = vi.fn(async () =>
    opts.noFile
      ? undefined
      : {
          filename: "poster.pdf",
          mimetype: "application/pdf",
          toBuffer: opts.toBuffer ?? (async () => pdf),
        },
  );
  const req = {
    headers: { "x-abstract-token": token, ...opts.headers },
    query: {},
    ip: "203.0.113.9",
    file,
  };
  return { req, file };
}

const abstracts = {
  getAbstractByToken: vi.fn(async () => ({ id: abstractId })),
} as unknown as AbstractsService;
const controller = new AbstractsPublicController(
  {} as AbstractsService,
  new AbstractsFinalFileService(abstracts),
);

async function upload(req: ReturnType<typeof multipartRequest>["req"]) {
  return controller.uploadFinalFile({ id: abstractId }, {}, req as never);
}

async function rejection(req: ReturnType<typeof multipartRequest>["req"]) {
  const err = await upload(req).then(
    () => {
      throw new Error("expected the upload to be rejected");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  const ex = err as AppException;
  return { status: ex.getStatus(), body: ex.getResponse() as { code: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock(findEventClientId).mockResolvedValue({ id: eventId, clientId: "client-1" });
  mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract());
  mock(updateAbstractFinalFileTxn).mockImplementation(
    async (_id: string, prepare: (row: unknown) => unknown) => {
      prepare(makeAbstract());
      return { previousKey: null };
    },
  );
  uploadPrivate.mockImplementation(async (_buffer: Buffer, key: string) => key);
});

describe("POST abstracts/:id/final-file — checks run before the body is read", () => {
  it("malformed token → 401, body never read", async () => {
    const { req, file } = multipartRequest({ headers: { "x-abstract-token": "short" } });
    const { status, body } = await rejection(req);
    expect(status).toBe(401);
    expect(body.code).toBe(ErrorCodes.INVALID_TOKEN);
    expect(file).not.toHaveBeenCalled();
    expect(findAbstractForFinalFile).not.toHaveBeenCalled();
  });

  it("well-formed but wrong token → 404, body never read", async () => {
    const { req, file } = multipartRequest({
      headers: { "x-abstract-token": "b".repeat(64) },
    });
    const { status, body } = await rejection(req);
    expect(status).toBe(404);
    expect(body.code).toBe(ErrorCodes.NOT_FOUND);
    expect(file).not.toHaveBeenCalled();
  });

  it("unknown abstract → 404, body never read", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(null);
    const { req, file } = multipartRequest();
    const { status } = await rejection(req);
    expect(status).toBe(404);
    expect(file).not.toHaveBeenCalled();
  });

  it("abstracts module disabled → 403, body never read", async () => {
    mock(assertClientModuleEnabled).mockRejectedValueOnce(
      new AppException(ErrorCodes.FORBIDDEN, "Abstracts module is disabled", 403),
    );
    const { req, file } = multipartRequest();
    const { status } = await rejection(req);
    expect(status).toBe(403);
    expect(file).not.toHaveBeenCalled();
  });

  it("abstract not ACCEPTED → 409, body never read", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(makeAbstract({ status: "PENDING" }));
    const { req, file } = multipartRequest();
    const { status, body } = await rejection(req);
    expect(status).toBe(409);
    expect(body.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
    expect(file).not.toHaveBeenCalled();
  });

  it("final-file upload disabled → 409, body never read", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({ config: { finalFileUploadEnabled: false, finalFileDeadline: null } }),
    );
    const { req, file } = multipartRequest();
    const { status, body } = await rejection(req);
    expect(status).toBe(409);
    expect(body.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(file).not.toHaveBeenCalled();
  });

  it("deadline passed → 409, body never read", async () => {
    mock(findAbstractForFinalFile).mockResolvedValue(
      makeAbstract({
        config: {
          finalFileUploadEnabled: true,
          finalFileDeadline: new Date("2020-01-01T00:00:00.000Z"),
        },
      }),
    );
    const { req, file } = multipartRequest();
    const { status } = await rejection(req);
    expect(status).toBe(409);
    expect(file).not.toHaveBeenCalled();
  });

  it("declared Content-Length above 50MB + framing margin → 413 FILE_TOO_LARGE, no DB read, body never read", async () => {
    const { req, file } = multipartRequest({
      headers: {
        "content-length": String(MAX_FINAL_FILE_SIZE + MULTIPART_OVERHEAD_BYTES + 1),
      },
    });
    const { status, body } = await rejection(req);
    expect(status).toBe(413);
    expect(body.code).toBe(ErrorCodes.FILE_TOO_LARGE);
    expect(file).not.toHaveBeenCalled();
    expect(findAbstractForFinalFile).not.toHaveBeenCalled();
  });
});

describe("POST abstracts/:id/final-file — reading the body", () => {
  it("accepts a declared Content-Length inside the framing margin and uploads", async () => {
    const { req, file } = multipartRequest({
      headers: { "content-length": String(MAX_FINAL_FILE_SIZE + MULTIPART_OVERHEAD_BYTES) },
    });
    await upload(req);
    expect(file).toHaveBeenCalledWith({ limits: { fileSize: MAX_FINAL_FILE_SIZE } });
    expect(uploadPrivate).toHaveBeenCalledTimes(1);
    expect(updateAbstractFinalFileTxn).toHaveBeenCalledTimes(1);
  });

  it("without Content-Length (chunked) the multipart fileSize limit still applies", async () => {
    const { req, file } = multipartRequest();
    await upload(req);
    expect(file).toHaveBeenCalledWith({ limits: { fileSize: MAX_FINAL_FILE_SIZE } });
    expect(uploadPrivate).toHaveBeenCalledTimes(1);
  });

  it("maps a multipart fileSize overflow to 413 FILE_TOO_LARGE (not a 500), no upload", async () => {
    const tooLarge = Object.assign(new Error("request file too large"), {
      code: "FST_REQ_FILE_TOO_LARGE",
      statusCode: 413,
    });
    const { req } = multipartRequest({ toBuffer: () => Promise.reject(tooLarge) });
    const { status, body } = await rejection(req);
    expect(status).toBe(413);
    expect(body.code).toBe(ErrorCodes.FILE_TOO_LARGE);
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it("no file part → 400 VALIDATION_ERROR after the checks pass", async () => {
    const { req, file } = multipartRequest({ noFile: true });
    const err = await upload(req).catch((e: unknown) => e);
    expect(file).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ status: 400 });
    expect(uploadPrivate).not.toHaveBeenCalled();
  });
});

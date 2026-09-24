import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import JSZip from "jszip";
import { fileTypeFromBuffer } from "file-type";
import { ErrorCodes } from "@app/contracts";
import {
  findAbstractForFinalFile,
  updateAbstractFinalFileTxn,
  type AbstractForFinalFile,
} from "@app/db";
import { getStorageProvider, ownedStorageKey } from "@app/integrations";
import { logger } from "../../core/logger.service";
import { AppException } from "../../core/app-exception";
import { verifyAbstractToken } from "./abstracts.token";
import { AbstractsService, assertAbstractModuleEnabled } from "./abstracts.service";

type AbstractFileKind = "PDF" | "PPT" | "PPTX";

export interface FinalFileInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

export const MAX_FINAL_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Content-Length counts the whole multipart body, not just the file. This fixed
 * margin covers the boundary lines and headers around the single file part the
 * form sends (busboy caps each part's headers far below it).
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function finalFileTooLarge(): AppException {
  return new AppException(
    ErrorCodes.FILE_TOO_LARGE,
    "Final file is too large. Maximum: 50MB.",
    413,
  );
}

/**
 * Rejects a declared body that cannot hold a file within the limit, before any
 * of it is read. Without Content-Length (chunked), the multipart fileSize limit
 * stops the stream instead.
 */
export function assertFinalFileContentLength(contentLength: string | undefined): void {
  if (contentLength === undefined) return;
  const declared = Number(contentLength);
  if (
    Number.isFinite(declared) &&
    declared > MAX_FINAL_FILE_SIZE + MULTIPART_OVERHEAD_BYTES
  ) {
    throw finalFileTooLarge();
  }
}

const CONTENT_TYPES: Record<AbstractFileKind, string> = {
  PDF: "application/pdf",
  PPT: "application/vnd.ms-powerpoint",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const EXTENSIONS: Record<AbstractFileKind, string> = {
  PDF: "pdf",
  PPT: "ppt",
  PPTX: "pptx",
};

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function hasPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function hasOleSignature(buffer: Buffer): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return signature.every((byte, index) => buffer[index] === byte);
}

async function isPowerPointOpenXml(buffer: Buffer): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    return Boolean(
      zip.file("[Content_Types].xml") && zip.file("ppt/presentation.xml"),
    );
  } catch {
    return false;
  }
}

async function detectFinalFileKind(file: {
  buffer: Buffer;
  filename: string;
}): Promise<AbstractFileKind> {
  const detected = await fileTypeFromBuffer(file.buffer);
  const extension = getExtension(file.filename);

  if (
    extension === "pdf" &&
    detected?.mime === "application/pdf" &&
    hasPdfSignature(file.buffer)
  ) {
    return "PDF";
  }

  if (
    extension === "pptx" &&
    (detected?.ext === "pptx" || detected?.mime === "application/zip") &&
    (await isPowerPointOpenXml(file.buffer))
  ) {
    return "PPTX";
  }

  if (
    extension === "ppt" &&
    (detected?.mime === CONTENT_TYPES.PPT ||
      detected?.mime === "application/x-cfb" ||
      hasOleSignature(file.buffer))
  ) {
    return "PPT";
  }

  throw new AppException(
    ErrorCodes.INVALID_FILE_TYPE,
    "Invalid final file type. Upload a valid PDF, PPT, or PPTX file.",
    400,
  );
}

// H1: finalType is one of CONFERENCE / ORAL_COMMUNICATION / POSTER once set
// (or null before finalize). Only POSTER restricts the uploaded kind; the
// other two accept PDF/PPT/PPTX. Previously any non-POSTER, non-
// ORAL_COMMUNICATION finalType (i.e. CONFERENCE) fell through to the "not
// set yet" 409 — this distinguishes "no finalType yet" from "kind not
// allowed" instead of conflating the two under one misleading message.
function assertKindAllowed(
  kind: AbstractFileKind,
  finalType: string | null,
): void {
  if (finalType == null) {
    throw new AppException(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      "Final presentation type has not been set for this abstract yet.",
      409,
    );
  }
  if (finalType === "POSTER" && kind !== "PDF") {
    throw new AppException(
      ErrorCodes.INVALID_FILE_TYPE,
      "Poster final files must be uploaded as PDF.",
      400,
    );
  }
  // ORAL_COMMUNICATION, POSTER (already PDF-checked above), and CONFERENCE
  // all accept any detected kind (PDF/PPT/PPTX).
}

function assertAbstractToken(
  abstract: AbstractForFinalFile | null,
  token: string,
): asserts abstract is AbstractForFinalFile {
  if (!abstract) {
    throw new AppException(ErrorCodes.NOT_FOUND, "Abstract not found", 404);
  }
  if (!verifyAbstractToken(abstract.editToken, token)) {
    throw new AppException(
      ErrorCodes.NOT_FOUND,
      "Invalid abstract token",
      404,
    );
  }
}

function assertUploadWindowOpen(abstract: AbstractForFinalFile): void {
  if (abstract.status !== "ACCEPTED") {
    throw new AppException(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      "Final files can only be uploaded after acceptance.",
      409,
    );
  }

  const config = abstract.config;
  if (!config?.finalFileUploadEnabled) {
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Final file upload is not enabled.",
      409,
    );
  }
  if (
    config.finalFileDeadline &&
    config.finalFileDeadline.getTime() < Date.now()
  ) {
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Final file upload deadline has passed.",
      409,
    );
  }
}

async function deleteObjectBestEffort(
  key: string,
  context: Record<string, unknown>,
  message: string,
): Promise<void> {
  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    logger.warn({ err, key, ...context }, message);
  }
}

@Injectable()
export class AbstractsFinalFileService {
  constructor(private readonly abstracts: AbstractsService) {}

  /**
   * `readFile` is called only after every check that needs no file has passed,
   * so an anonymous caller with a bad token or a closed window never gets the
   * request body buffered. The same checks run again under a row lock at write
   * time; the early pass is only a gate.
   */
  async uploadAbstractFinalFile(
    abstractId: string,
    token: string,
    readFile: () => Promise<FinalFileInput>,
    ipAddress?: string,
  ) {
    const abstract = await findAbstractForFinalFile(abstractId);
    assertAbstractToken(abstract, token);
    await assertAbstractModuleEnabled(abstract.eventId);
    assertUploadWindowOpen(abstract);

    const file = await readFile();
    if (file.buffer.length > MAX_FINAL_FILE_SIZE) {
      throw finalFileTooLarge();
    }

    const kind = await detectFinalFileKind(file);
    assertKindAllowed(kind, abstract.finalType);

    const ext = EXTENSIONS[kind];
    const ownedPrefix = `${abstract.eventId}/abstracts/${abstract.id}`;
    // A fresh key per upload, so the object the row points at is never overwritten.
    const key = `${ownedPrefix}/final-${randomUUID()}.${ext}`;

    let storedKey: string;
    try {
      storedKey = await getStorageProvider().uploadPrivate(
        file.buffer,
        key,
        CONTENT_TYPES[kind],
        { contentDisposition: `attachment; filename="abstract-final.${ext}"` },
      );
    } catch (err) {
      logger.error(
        { err, abstractId, key },
        "Failed to upload abstract final file",
      );
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to upload final file. Please try again.",
        500,
      );
    }

    let previousKey: string | null;
    try {
      await assertAbstractModuleEnabled(abstract.eventId);
      ({ previousKey } = await updateAbstractFinalFileTxn(abstractId, (current) => {
        assertAbstractToken(current, token);
        assertUploadWindowOpen(current);
        assertKindAllowed(kind, current.finalType);
        return {
          fields: {
            finalFileKey: storedKey,
            finalFileKind: kind,
            finalFileSize: file.buffer.length,
            finalFileUploadedAt: new Date(),
          },
          audit: {
            entityType: "Abstract",
            entityId: abstractId,
            action: "final_file_upload",
            changes: {
              finalFileKey: { old: current.finalFileKey, new: storedKey },
              finalFileKind: { old: current.finalFileKind, new: kind },
              finalFileSize: {
                old: current.finalFileSize,
                new: file.buffer.length,
              },
            },
            performedBy: "PUBLIC",
            ipAddress: ipAddress ?? null,
          },
        };
      }));
    } catch (err) {
      // The row still points at the previous file; drop the one nobody references.
      await deleteObjectBestEffort(
        storedKey,
        { abstractId },
        "Failed to delete unreferenced abstract final file",
      );
      throw err;
    }

    if (previousKey && previousKey !== storedKey) {
      const oldKey = ownedStorageKey(previousKey, ownedPrefix);
      if (oldKey) {
        await deleteObjectBestEffort(
          oldKey,
          { abstractId },
          "Failed to delete old abstract final file",
        );
      } else {
        logger.warn(
          { abstractId, key: previousKey },
          "Previous abstract final file is outside the abstract's storage prefix; not deleting",
        );
      }
    }

    return this.abstracts.getAbstractByToken(abstractId, token);
  }
}

import { Injectable } from "@nestjs/common";
import JSZip from "jszip";
import { fileTypeFromBuffer } from "file-type";
import { ErrorCodes } from "@app/contracts";
import { findAbstractForFinalFile, updateAbstractFinalFileTxn } from "@app/db";
import { getStorageProvider } from "@app/integrations";
import { logger } from "../../core/logger.service";
import { AppException } from "./app-exception";
import { verifyAbstractToken } from "./abstracts.token";
import { AbstractsService } from "./abstracts.service";

type AbstractFileKind = "PDF" | "PPT" | "PPTX";

const MAX_FINAL_FILE_SIZE = 50 * 1024 * 1024; // 50MB

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

function assertKindAllowed(
  kind: AbstractFileKind,
  finalType: string | null,
): void {
  if (finalType === "POSTER" && kind !== "PDF") {
    throw new AppException(
      ErrorCodes.INVALID_FILE_TYPE,
      "Poster final files must be uploaded as PDF.",
      400,
    );
  }
  if (finalType === "ORAL_COMMUNICATION") return;
  if (finalType !== "POSTER") {
    throw new AppException(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      "Final presentation type is required before uploading a final file.",
      409,
    );
  }
}

@Injectable()
export class AbstractsFinalFileService {
  constructor(private readonly abstracts: AbstractsService) {}

  async uploadAbstractFinalFile(
    abstractId: string,
    token: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
    ipAddress?: string,
  ) {
    if (file.buffer.length > MAX_FINAL_FILE_SIZE) {
      throw new AppException(
        ErrorCodes.FILE_TOO_LARGE,
        "Final file is too large. Maximum: 50MB.",
        400,
      );
    }

    const abstract = await findAbstractForFinalFile(abstractId);
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

    const kind = await detectFinalFileKind(file);
    assertKindAllowed(kind, abstract.finalType);

    const ext = EXTENSIONS[kind];
    const key = `${abstract.eventId}/abstracts/${abstract.id}/final.${ext}`;
    const storage = getStorageProvider();

    if (abstract.finalFileKey && abstract.finalFileKey !== key) {
      try {
        await storage.delete(abstract.finalFileKey);
      } catch (err) {
        logger.warn(
          { err, abstractId, key: abstract.finalFileKey },
          "Failed to delete old abstract final file",
        );
      }
    }

    let storedKey: string;
    try {
      storedKey = await storage.uploadPrivate(
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

    const uploadedAt = new Date();
    await updateAbstractFinalFileTxn(
      abstractId,
      {
        finalFileKey: storedKey,
        finalFileKind: kind,
        finalFileSize: file.buffer.length,
        finalFileUploadedAt: uploadedAt,
      },
      {
        entityType: "Abstract",
        entityId: abstractId,
        action: "final_file_upload",
        changes: {
          finalFileKey: { old: abstract.finalFileKey, new: storedKey },
          finalFileKind: { old: abstract.finalFileKind, new: kind },
          finalFileSize: {
            old: abstract.finalFileSize,
            new: file.buffer.length,
          },
        },
        performedBy: "PUBLIC",
        ipAddress: ipAddress ?? null,
      },
    );

    return this.abstracts.getAbstractByToken(abstractId, token);
  }
}

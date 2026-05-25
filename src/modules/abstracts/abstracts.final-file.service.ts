import JSZip from "jszip";
import { fileTypeFromBuffer } from "file-type";
import { prisma } from "@/database/client.js";
import { AbstractFileKind, AbstractStatus } from "@/generated/prisma/client.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import { auditLog } from "@shared/utils/audit.js";
import { verifyAbstractToken } from "./abstract-token.js";
import { getAbstractByToken } from "./abstracts.service.js";

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
    return Boolean(zip.file("[Content_Types].xml") && zip.file("ppt/presentation.xml"));
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

  if (extension === "pdf" && detected?.mime === "application/pdf" && hasPdfSignature(file.buffer)) {
    return AbstractFileKind.PDF;
  }

  if (
    extension === "pptx" &&
    (detected?.ext === "pptx" || detected?.mime === "application/zip") &&
    (await isPowerPointOpenXml(file.buffer))
  ) {
    return AbstractFileKind.PPTX;
  }

  if (
    extension === "ppt" &&
    (detected?.mime === CONTENT_TYPES.PPT ||
      detected?.mime === "application/x-cfb" ||
      hasOleSignature(file.buffer))
  ) {
    return AbstractFileKind.PPT;
  }

  throw new AppError(
    "Invalid final file type. Upload a valid PDF, PPT, or PPTX file.",
    400,
    ErrorCodes.INVALID_FILE_TYPE,
  );
}

function assertKindAllowed(kind: AbstractFileKind, finalType: string | null): void {
  if (finalType === "POSTER" && kind !== AbstractFileKind.PDF) {
    throw new AppError(
      "Poster final files must be uploaded as PDF.",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }
  if (finalType === "ORAL_COMMUNICATION") return;
  if (finalType !== "POSTER") {
    throw new AppError(
      "Final presentation type is required before uploading a final file.",
      409,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
  }
}

export async function uploadAbstractFinalFile(
  abstractId: string,
  token: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  ipAddress?: string,
) {
  if (file.buffer.length > MAX_FINAL_FILE_SIZE) {
    throw new AppError(
      "Final file is too large. Maximum: 50MB.",
      400,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }

  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: {
      event: {
        select: {
          abstractConfig: {
            select: {
              finalFileUploadEnabled: true,
              finalFileDeadline: true,
            },
          },
        },
      },
    },
  });

  if (!abstract) {
    throw new AppError("Abstract not found", 404, ErrorCodes.NOT_FOUND);
  }
  if (!verifyAbstractToken(abstract.editToken, token)) {
    throw new AppError("Invalid abstract token", 404, ErrorCodes.NOT_FOUND);
  }
  if (abstract.status !== AbstractStatus.ACCEPTED) {
    throw new AppError(
      "Final files can only be uploaded after acceptance.",
      409,
      ErrorCodes.INVALID_STATUS_TRANSITION,
    );
  }

  const config = abstract.event.abstractConfig;
  if (!config?.finalFileUploadEnabled) {
    throw new AppError(
      "Final file upload is not enabled.",
      409,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (config.finalFileDeadline && config.finalFileDeadline.getTime() < Date.now()) {
    throw new AppError(
      "Final file upload deadline has passed.",
      409,
      ErrorCodes.VALIDATION_ERROR,
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
    storedKey = await storage.uploadPrivate(file.buffer, key, CONTENT_TYPES[kind], {
      contentDisposition: `attachment; filename="abstract-final.${ext}"`,
    });
  } catch (err) {
    logger.error({ err, abstractId, key }, "Failed to upload abstract final file");
    throw new AppError(
      "Failed to upload final file. Please try again.",
      500,
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  const uploadedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.abstract.update({
      where: { id: abstractId },
      data: {
        finalFileKey: storedKey,
        finalFileKind: kind,
        finalFileSize: file.buffer.length,
        finalFileUploadedAt: uploadedAt,
      },
    });

    await auditLog(tx, {
      entityType: "Abstract",
      entityId: abstractId,
      action: "final_file_upload",
      changes: {
        finalFileKey: { old: abstract.finalFileKey, new: storedKey },
        finalFileKind: { old: abstract.finalFileKind, new: kind },
        finalFileSize: { old: abstract.finalFileSize, new: file.buffer.length },
      },
      performedBy: "PUBLIC",
      ipAddress,
    });
  });

  return getAbstractByToken(abstractId, token);
}

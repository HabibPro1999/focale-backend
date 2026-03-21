import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { logger } from "@shared/utils/logger.js";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { Prisma } from "@/generated/prisma/client.js";
import type {
  CreateCertificateTemplateInput,
  UpdateCertificateTemplateInput,
} from "./certificates.schema.js";

// ============================================================================
// Helpers
// ============================================================================

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

const accessSelect = { select: { id: true, name: true, type: true } } as const;

/**
 * Extract storage key from a full URL.
 * Handles both Firebase and R2 URL formats.
 */
function extractKeyFromStorage(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.slice(1).join("/");
    }
    return parsed.pathname.slice(1);
  } catch {
    return null;
  }
}

// ============================================================================
// List Templates
// ============================================================================

export async function listTemplates(eventId: string) {
  return prisma.certificateTemplate.findMany({
    where: { eventId },
    include: { access: accessSelect },
    orderBy: { createdAt: "desc" },
  });
}

// ============================================================================
// Get Template
// ============================================================================

export async function getTemplate(id: string) {
  const template = await prisma.certificateTemplate.findUnique({
    where: { id },
    include: {
      access: accessSelect,
      event: { select: { clientId: true } },
    },
  });

  if (!template) {
    throw new AppError(
      "Certificate template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  return template;
}

// ============================================================================
// Create Template
// ============================================================================

export async function createTemplate(
  eventId: string,
  input: CreateCertificateTemplateInput,
) {
  return prisma.certificateTemplate.create({
    data: {
      eventId,
      name: input.name,
      templateUrl: "",
      templateWidth: 0,
      templateHeight: 0,
      applicableRoles: input.applicableRoles ?? [],
      accessId: input.accessId ?? null,
    },
    include: { access: accessSelect },
  });
}

// ============================================================================
// Update Template
// ============================================================================

export async function updateTemplate(
  id: string,
  input: UpdateCertificateTemplateInput,
) {
  const data: Prisma.CertificateTemplateUpdateInput = {};

  // Fetch current state once when we need it for validation or relation logic
  const needsCurrent =
    input.active === true ||
    (input.accessId !== undefined && input.accessId === null);

  let current: { templateUrl: string; accessId: string | null } | null = null;
  if (needsCurrent) {
    current = await prisma.certificateTemplate.findUnique({
      where: { id },
      select: { templateUrl: true, accessId: true },
    });
  }

  // Guard: cannot activate a template that has no uploaded image
  if (input.active === true && !current?.templateUrl) {
    throw new AppError(
      "Cannot activate a certificate template without an uploaded image",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  if (input.name !== undefined) data.name = input.name;
  if (input.zones !== undefined)
    data.zones = input.zones as Prisma.InputJsonValue;
  if (input.applicableRoles !== undefined)
    data.applicableRoles = input.applicableRoles;
  if (input.active !== undefined) data.active = input.active;

  // accessId: allow setting to null (unlink) or a new uuid.
  // Only disconnect if a relation currently exists (Prisma throws otherwise).
  if (input.accessId !== undefined) {
    if (input.accessId === null) {
      if (current?.accessId) {
        data.access = { disconnect: true };
      }
    } else {
      data.access = { connect: { id: input.accessId } };
    }
  }

  return prisma.certificateTemplate.update({
    where: { id },
    data,
    include: { access: accessSelect },
  });
}

// ============================================================================
// Delete Template
// ============================================================================

export async function deleteTemplate(id: string) {
  const template = await prisma.certificateTemplate.findUnique({
    where: { id },
    select: { id: true, templateUrl: true },
  });

  if (!template) {
    throw new AppError(
      "Certificate template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Delete stored image if present
  if (template.templateUrl) {
    const key = extractKeyFromStorage(template.templateUrl);
    if (key) {
      try {
        await getStorageProvider().delete(key);
      } catch (err) {
        logger.warn(
          { err, key },
          "Failed to delete certificate template image",
        );
      }
    }
  }

  await prisma.certificateTemplate.delete({ where: { id } });
}

// ============================================================================
// Upload Template Image
// ============================================================================

export async function uploadTemplateImage(
  id: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
) {
  // Validate via magic bytes — never trust Content-Type header
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
    throw new AppError(
      "Only PNG and JPEG images are allowed",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  const template = await prisma.certificateTemplate.findUnique({
    where: { id },
    select: { id: true, eventId: true, templateUrl: true },
  });

  if (!template) {
    throw new AppError(
      "Certificate template not found",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Delete old image if present
  if (template.templateUrl) {
    const oldKey = extractKeyFromStorage(template.templateUrl);
    if (oldKey) {
      try {
        await getStorageProvider().delete(oldKey);
      } catch (err) {
        logger.warn({ err, oldKey }, "Failed to delete old certificate image");
      }
    }
  }

  // Get image dimensions
  const metadata = await sharp(file.buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  // Store at original quality (no compression — print quality)
  const ext = MIME_TO_EXT[detected.mime] ?? "png";
  const key = `${template.eventId}/certificates/${template.id}.${ext}`;
  const templateUrl = await getStorageProvider().upload(
    file.buffer,
    key,
    detected.mime,
  );

  return prisma.certificateTemplate.update({
    where: { id },
    data: {
      templateUrl,
      templateWidth: width,
      templateHeight: height,
    },
    include: { access: accessSelect },
  });
}

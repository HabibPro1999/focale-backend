// =============================================================================
// SERVER-SIDE CERTIFICATE PDF GENERATION
// Ported from admin/src/features/certificates/utils/generateCertificate.ts
// Uses pdf-lib (isomorphic) to generate certificate PDFs with text zones
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { downloadTemplateImage } from "./certificates.service.js";
import { logger } from "@shared/utils/logger.js";
import type { CertificateZone } from "./certificates.schema.js";
import type { EmailAttachment } from "@modules/email/email-sendgrid.service.js";

// =============================================================================
// TYPES
// =============================================================================

export type ImageCache = Map<string, Buffer>;

export interface CertificateTemplateData {
  id: string;
  name: string;
  templateUrl: string;
  templateWidth: number;
  templateHeight: number;
  zones: CertificateZone[];
  applicableRoles: string[];
  accessId: string | null;
  access: { id: string; name: string } | null;
}

export interface RegistrationForCertificate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  checkedInAt: Date | null;
  accessCheckIns: Array<{ accessId: string }>;
  event: {
    name: string;
    startDate: Date;
    location: string | null;
  };
}

// =============================================================================
// VARIABLE RESOLUTION
// =============================================================================

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function resolveCertificateVariable(
  variableId: string,
  data: {
    firstName?: string | null;
    lastName?: string | null;
    role?: string;
    eventName?: string;
    eventDate?: string;
    eventLocation?: string | null;
    accessName?: string;
  },
): string {
  switch (variableId) {
    case "fullName":
      return [data.firstName, data.lastName].filter(Boolean).join(" ") || "—";
    case "firstName":
      return data.firstName || "—";
    case "lastName":
      return data.lastName || "—";
    case "role":
      return data.role || "Participant";
    case "eventName":
      return data.eventName || "—";
    case "eventDate":
      return data.eventDate || "—";
    case "eventLocation":
      return data.eventLocation || "—";
    case "accessName":
      return data.accessName || "—";
    case "issuanceDate":
      return formatDate(new Date());
    default:
      return "—";
  }
}

// =============================================================================
// PDF GENERATION HELPERS
// =============================================================================

function findFitFontSize(
  font: {
    widthOfTextAtSize: (text: string, size: number) => number;
    heightAtSize: (size: number) => number;
  },
  text: string,
  maxWidth: number,
  maxHeight: number,
  maxFontSize = 72,
  minFontSize = 8,
): number {
  let lo = minFontSize;
  let hi = maxFontSize;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    const width = font.widthOfTextAtSize(text, mid);
    const height = font.heightAtSize(mid);
    if (width <= maxWidth && height <= maxHeight) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.floor(lo);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1], 16) / 255,
    g: parseInt(match[2], 16) / 255,
    b: parseInt(match[3], 16) / 255,
  };
}

// =============================================================================
// SINGLE PDF GENERATION
// =============================================================================

async function getTemplateImageBuffer(
  templateUrl: string,
  imageCache: ImageCache,
): Promise<Buffer> {
  const cached = imageCache.get(templateUrl);
  if (cached) return cached;

  const file = await downloadTemplateImage(templateUrl);
  imageCache.set(templateUrl, file.buffer);
  return file.buffer;
}

export async function generateCertificatePdf(
  template: {
    templateUrl: string;
    templateWidth: number;
    templateHeight: number;
    zones: CertificateZone[];
  },
  resolvedValues: Record<string, string>,
  imageCache: ImageCache,
): Promise<Buffer> {
  const imageBuffer = await getTemplateImageBuffer(
    template.templateUrl,
    imageCache,
  );

  const pdfDoc = await PDFDocument.create();

  // Detect format from magic bytes
  const isPng = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
  const isJpg = imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8;

  let image;
  if (isPng) {
    image = await pdfDoc.embedPng(imageBuffer);
  } else if (isJpg) {
    image = await pdfDoc.embedJpg(imageBuffer);
  } else {
    throw new Error("Unsupported image format. Only PNG and JPEG are supported.");
  }

  const { templateWidth, templateHeight } = template;
  const page = pdfDoc.addPage([templateWidth, templateHeight]);

  page.drawImage(image, {
    x: 0,
    y: 0,
    width: templateWidth,
    height: templateHeight,
  });

  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const zone of template.zones) {
    const text = resolvedValues[zone.variable] || "";
    if (!text || text === "—") continue;

    const font = zone.fontWeight === "bold" ? boldFont : regularFont;

    const zoneX = (zone.x / 100) * templateWidth;
    const zoneY = (zone.y / 100) * templateHeight;
    const zoneW = (zone.width / 100) * templateWidth;
    const zoneH = (zone.height / 100) * templateHeight;

    const fontSize =
      zone.fontSize != null
        ? zone.fontSize
        : findFitFontSize(font, text, zoneW, zoneH);

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);

    let textX = zoneX;
    if (zone.textAlign === "center") {
      textX = zoneX + (zoneW - textWidth) / 2;
    } else if (zone.textAlign === "right") {
      textX = zoneX + zoneW - textWidth;
    }

    // PDF origin is bottom-left; zone Y is from top
    const textY = templateHeight - zoneY - zoneH + (zoneH - textHeight) / 2;

    const { r, g, b } = hexToRgb(zone.color);

    page.drawText(text, {
      x: textX,
      y: textY,
      size: fontSize,
      font,
      color: rgb(r, g, b),
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// =============================================================================
// ELIGIBILITY CHECK
// =============================================================================

export function isEligibleForCertificate(
  registration: RegistrationForCertificate,
  template: CertificateTemplateData,
): boolean {
  // Role check: empty applicableRoles = all roles eligible
  const roleMatch =
    template.applicableRoles.length === 0 ||
    template.applicableRoles.includes(registration.role);

  if (!roleMatch) return false;

  // Check-in check: must have actually attended
  if (template.accessId) {
    // Access-specific cert: need check-in for that specific access
    return registration.accessCheckIns.some(
      (c) => c.accessId === template.accessId,
    );
  } else {
    // Main event cert: need event-level check-in
    return registration.checkedInAt !== null;
  }
}

// =============================================================================
// GENERATE ALL CERTIFICATE ATTACHMENTS FOR ONE REGISTRANT
// =============================================================================

export async function generateCertificateAttachments(
  registration: RegistrationForCertificate,
  templates: CertificateTemplateData[],
  imageCache: ImageCache,
): Promise<EmailAttachment[]> {
  const attachments: EmailAttachment[] = [];

  for (const template of templates) {
    if (!isEligibleForCertificate(registration, template)) continue;

    // Resolve variables for this certificate
    const variableData = {
      firstName: registration.firstName,
      lastName: registration.lastName,
      role: registration.role,
      eventName: registration.event.name,
      eventDate: formatDate(registration.event.startDate),
      eventLocation: registration.event.location,
      accessName: template.access?.name,
    };

    const resolvedValues: Record<string, string> = {};
    for (const zone of template.zones) {
      resolvedValues[zone.variable] = resolveCertificateVariable(
        zone.variable,
        variableData,
      );
    }

    try {
      const pdfBuffer = await generateCertificatePdf(
        template,
        resolvedValues,
        imageCache,
      );

      const safeTemplateName = template.name.replace(/[^a-zA-Z0-9-_\s]/g, "").replace(/\s+/g, "-");
      const shortId = registration.id.slice(0, 8);

      attachments.push({
        content: pdfBuffer.toString("base64"),
        filename: `${safeTemplateName}-${shortId}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
      });
    } catch (error) {
      logger.error(
        {
          templateId: template.id,
          registrationId: registration.id,
          error: (error as Error).message,
        },
        "Failed to generate certificate PDF",
      );
      // Skip this certificate but continue with others
    }
  }

  return attachments;
}

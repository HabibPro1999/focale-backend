// =============================================================================
// SERVER-SIDE CERTIFICATE PDF GENERATION (framework-free)
// Ported from the legacy certificate-pdf.service.ts. Lives in @app/integrations
// because the worker email queue renders certificate attachments here (via the
// injected CertificateAttachmentGenerator seam in ./email/queue). Depends only
// on db/shared/contracts + pdf-lib/fontkit/color-name + the storage provider.
// =============================================================================

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import { readFile } from "node:fs/promises";
import type { CertificateZone } from "@app/contracts";
import {
  getRegistrationForCertificateGeneration,
  getAbstractForCertificateGeneration,
  getActiveImageReadyCertificateTemplatesByIds,
} from "@app/db";
import { getStorageProvider } from "./storage/index";
import { logger } from "./logger";
import type { EmailAttachment } from "./email/index";
import type {
  CertificateAttachmentContext,
  CertificateAttachmentGenerator,
} from "./email/index";

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

/** Abstract-shaped input to generateAbstractCertificateAttachments (H2) —
 * presenter certs have no role/check-in concept, so this is intentionally
 * narrower than RegistrationForCertificate. */
export interface AbstractForCertificate {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  finalType: string | null;
  requestedType: string;
  code: string | null;
  content: unknown;
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

/** Mirrors the local `getTitle`/`getAbstractTitle` helper duplicated across the
 * abstracts + certificates API modules — title lives in the free-form `content`
 * jsonb, not a dedicated column. */
function getAbstractTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

/** Superset of the variables either a registration cert or an abstract
 * (presenter) cert zone can reference. Shared by both generation paths so
 * resolveCertificateVariable / generateCertificatePdf never fork per-subject. */
export interface CertificateVariableData {
  firstName?: string | null;
  lastName?: string | null;
  role?: string;
  eventName?: string;
  eventDate?: string;
  eventLocation?: string | null;
  accessName?: string;
  // H2: abstract (presenter) certs only.
  abstractTitle?: string;
  abstractCode?: string | null;
  abstractFinalType?: string;
}

export function resolveCertificateVariable(
  variableId: string,
  data: CertificateVariableData,
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
    case "abstractTitle":
      return data.abstractTitle || "—";
    case "abstractCode":
      return data.abstractCode || "—";
    case "abstractFinalType":
      return data.abstractFinalType || "—";
    case "issuanceDate":
      return formatDate(new Date());
    default:
      return "—";
  }
}

// =============================================================================
// PDF GENERATION HELPERS
// =============================================================================

// color-name / dejavu-fonts-ttf are CommonJS packages (no type decls / bundled
// asset). @app/integrations is type:commonjs, so the global require resolves them.
const cssColorNames = require("color-name") as Record<
  string,
  [number, number, number]
>;

const DEFAULT_REGULAR_FONT_PATH = require.resolve(
  "dejavu-fonts-ttf/ttf/DejaVuSans.ttf",
);
const DEFAULT_BOLD_FONT_PATH = require.resolve(
  "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf",
);

const fontBytesCache = new Map<string, Uint8Array>();

async function loadFontBytes(path: string): Promise<Uint8Array> {
  const cached = fontBytesCache.get(path);
  if (cached) return cached;

  const bytes = await readFile(path);
  fontBytesCache.set(path, bytes);
  return bytes;
}

async function embedCertificateFonts(
  pdfDoc: PDFDocument,
): Promise<{ regularFont: PDFFont; boldFont: PDFFont }> {
  pdfDoc.registerFontkit(fontkit);

  const regularFontPath =
    process.env.CERTIFICATE_FONT_PATH ?? DEFAULT_REGULAR_FONT_PATH;
  const boldFontPath =
    process.env.CERTIFICATE_BOLD_FONT_PATH ?? DEFAULT_BOLD_FONT_PATH;

  const [regularBytes, boldBytes] = await Promise.all([
    loadFontBytes(regularFontPath),
    loadFontBytes(boldFontPath),
  ]);

  const [regularFont, boldFont] = await Promise.all([
    pdfDoc.embedFont(regularBytes, { subset: true }),
    pdfDoc.embedFont(boldBytes, { subset: true }),
  ]);

  return { regularFont, boldFont };
}

function findFitFontSize(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxHeight: number,
  maxFontSize = 72,
  minFontSize = 4,
): number {
  if (maxWidth <= 0 || maxHeight <= 0) return minFontSize;

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

function truncateTextToWidth(
  font: PDFFont,
  text: string,
  fontSize: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;

  const ellipsis = "...";
  if (font.widthOfTextAtSize(ellipsis, fontSize) > maxWidth) return "";

  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("")}${ellipsis}`;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return `${chars.slice(0, lo).join("")}${ellipsis}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getVerticalTextMetrics(
  font: PDFFont,
  size: number,
): { height: number; baselineOffset: number } {
  const fullHeight = font.heightAtSize(size, { descender: true });
  const ascenderHeight = font.heightAtSize(size, { descender: false });

  return {
    height: fullHeight,
    baselineOffset: Math.max(0, fullHeight - ascenderHeight),
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const color = hex.trim().toLowerCase();

  const shortHexMatch = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(color);
  if (shortHexMatch) {
    return {
      r: parseInt(shortHexMatch[1] + shortHexMatch[1], 16) / 255,
      g: parseInt(shortHexMatch[2] + shortHexMatch[2], 16) / 255,
      b: parseInt(shortHexMatch[3] + shortHexMatch[3], 16) / 255,
    };
  }

  const longHexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (longHexMatch) {
    return {
      r: parseInt(longHexMatch[1], 16) / 255,
      g: parseInt(longHexMatch[2], 16) / 255,
      b: parseInt(longHexMatch[3], 16) / 255,
    };
  }

  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.exec(
      color,
    );
  if (rgbMatch) {
    const channels = rgbMatch
      .slice(1, 4)
      .map((channel) => clamp(Number(channel), 0, 255) / 255);
    return { r: channels[0], g: channels[1], b: channels[2] };
  }

  const named = cssColorNames[color];
  if (named) {
    return {
      r: named[0] / 255,
      g: named[1] / 255,
      b: named[2] / 255,
    };
  }

  logger.warn(
    { color: hex },
    "Unsupported certificate text color; using black",
  );
  return { r: 0, g: 0, b: 0 };
}

function safeFilenameSegment(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-_\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);

  return sanitized || fallback;
}

export const __certificatePdfTestHooks = {
  hexToRgb,
  safeFilenameSegment,
  truncateTextToWidth,
};

function fitTextToZone(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxHeight: number,
  requestedFontSize: number | null,
): { text: string; fontSize: number } {
  const maxFontSize = requestedFontSize ?? 72;
  const fontSize = findFitFontSize(font, text, maxWidth, maxHeight, maxFontSize);
  const fittedText = truncateTextToWidth(font, text, fontSize, maxWidth);

  return {
    text: fittedText,
    fontSize,
  };
}

// =============================================================================
// STORAGE (template background image)
// =============================================================================

/** Extract storage key from a full URL. Handles Firebase + R2 formats. */
function extractKeyFromStorage(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

async function downloadTemplateImage(templateUrl: string): Promise<Buffer> {
  const key = extractKeyFromStorage(templateUrl);
  if (!key) {
    throw new Error(
      "Certificate template image is not stored in a supported location",
    );
  }
  const file = await getStorageProvider().download(key);
  return file.buffer;
}

async function getTemplateImageBuffer(
  templateUrl: string,
  imageCache: ImageCache,
): Promise<Buffer> {
  const cached = imageCache.get(templateUrl);
  if (cached) return cached;

  const buffer = await downloadTemplateImage(templateUrl);
  imageCache.set(templateUrl, buffer);
  return buffer;
}

// =============================================================================
// SINGLE PDF GENERATION
// =============================================================================

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
    throw new Error(
      "Unsupported image format. Only PNG and JPEG are supported.",
    );
  }

  const { templateWidth, templateHeight } = template;
  const page = pdfDoc.addPage([templateWidth, templateHeight]);

  page.drawImage(image, {
    x: 0,
    y: 0,
    width: templateWidth,
    height: templateHeight,
  });

  const { regularFont, boldFont } = await embedCertificateFonts(pdfDoc);

  for (const zone of template.zones) {
    const resolvedText = resolvedValues[zone.variable] || "";
    if (!resolvedText || resolvedText === "—") continue;

    const font = zone.fontWeight === "bold" ? boldFont : regularFont;

    const zoneX = (zone.x / 100) * templateWidth;
    const zoneY = (zone.y / 100) * templateHeight;
    const zoneW = (zone.width / 100) * templateWidth;
    const zoneH = (zone.height / 100) * templateHeight;

    const { text, fontSize } = fitTextToZone(
      font,
      resolvedText,
      zoneW,
      zoneH,
      zone.fontSize,
    );
    if (!text) continue;

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const { height: textHeight, baselineOffset } = getVerticalTextMetrics(
      font,
      fontSize,
    );

    let textX = zoneX;
    if (zone.textAlign === "center") {
      textX = zoneX + (zoneW - textWidth) / 2;
    } else if (zone.textAlign === "right") {
      textX = zoneX + zoneW - textWidth;
    }
    textX = clamp(textX, zoneX, zoneX + Math.max(0, zoneW - textWidth));

    // PDF origin is bottom-left; zone Y is from top
    const zoneBottom = templateHeight - zoneY - zoneH;
    const textY = clamp(
      zoneBottom + (zoneH - textHeight) / 2 + baselineOffset,
      zoneBottom,
      zoneBottom + Math.max(0, zoneH - textHeight) + baselineOffset,
    );

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
// GENERATE ALL CERTIFICATE ATTACHMENTS FOR ONE SUBJECT (registrant or abstract)
//
// Shared core: resolves per-template variables (accessName varies per
// template) then renders via generateCertificatePdf. Eligibility filtering is
// the caller's job — it differs per subject (role/check-in for registrations,
// none for abstracts) — this just renders whatever templates it's handed.
// =============================================================================

async function renderCertificateAttachments(
  templates: CertificateTemplateData[],
  baseVariableData: CertificateVariableData,
  filenameId: string,
  imageCache: ImageCache,
  logContext: Record<string, unknown>,
): Promise<EmailAttachment[]> {
  const attachments: EmailAttachment[] = [];

  for (const template of templates) {
    const variableData: CertificateVariableData = {
      ...baseVariableData,
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

      const safeTemplateName = safeFilenameSegment(template.name, "certificate");
      const templateShortId = template.id.slice(0, 8);
      const shortId = filenameId.slice(0, 8);

      attachments.push({
        content: pdfBuffer.toString("base64"),
        filename: `${safeTemplateName}-${templateShortId}-${shortId}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
      });
    } catch (error) {
      logger.error(
        {
          templateId: template.id,
          ...logContext,
          error: (error as Error).message,
        },
        "Failed to generate certificate PDF",
      );
      throw error;
    }
  }

  return attachments;
}

export async function generateCertificateAttachments(
  registration: RegistrationForCertificate,
  templates: CertificateTemplateData[],
  imageCache: ImageCache,
): Promise<EmailAttachment[]> {
  const eligible = templates.filter((t) =>
    isEligibleForCertificate(registration, t),
  );

  const variableData: CertificateVariableData = {
    firstName: registration.firstName,
    lastName: registration.lastName,
    role: registration.role,
    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate),
    eventLocation: registration.event.location,
  };

  return renderCertificateAttachments(
    eligible,
    variableData,
    registration.id,
    imageCache,
    { registrationId: registration.id },
  );
}

/**
 * Abstract presenter certificates (H2). No isEligibleForCertificate filter:
 * abstracts have no role/check-in state, so every template handed in applies
 * — mirrors apps/api CertificatesService.processAbstractCertificates, which
 * targets all active/image-ready templates for the event without the
 * role/check-in gate used for registrants.
 */
export async function generateAbstractCertificateAttachments(
  abstract: AbstractForCertificate,
  templates: CertificateTemplateData[],
  imageCache: ImageCache,
): Promise<EmailAttachment[]> {
  const variableData: CertificateVariableData = {
    firstName: abstract.authorFirstName,
    lastName: abstract.authorLastName,
    eventName: abstract.event.name,
    eventDate: formatDate(abstract.event.startDate),
    eventLocation: abstract.event.location,
    abstractTitle: getAbstractTitle(abstract.content),
    abstractCode: abstract.code,
    abstractFinalType: abstract.finalType ?? abstract.requestedType,
  };

  return renderCertificateAttachments(
    templates,
    variableData,
    abstract.id,
    imageCache,
    { abstractId: abstract.id },
  );
}

// =============================================================================
// WORKER SEAM — the CertificateAttachmentGenerator injected into
// processEmailQueue (email/queue.ts). Re-fetches the registration/abstract +
// re-validates that the queued templates are still active/image-ready at SEND
// time (§5), then renders. The "no attachments"/"fewer than queued" handling
// lives in the queue loop; this only produces the attachments (throwing when
// the subject or its templates vanished). Wired in
// apps/worker/src/jobs/email-queue.job.ts: processEmailQueue(batch, {
//   generateCertificateAttachments: generateCertificateEmailAttachments }).
// =============================================================================

function toCertificateTemplateData(
  templates: Awaited<
    ReturnType<typeof getActiveImageReadyCertificateTemplatesByIds>
  >,
): CertificateTemplateData[] {
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    templateUrl: t.templateUrl,
    templateWidth: t.templateWidth,
    templateHeight: t.templateHeight,
    zones: (t.zones as CertificateZone[]) ?? [],
    applicableRoles: (t.applicableRoles as string[] | null) ?? [],
    accessId: t.accessId,
    access: t.access ? { id: t.access.id, name: t.access.name } : null,
  }));
}

async function generateRegistrationCertificateEmailAttachments(
  registrationId: string,
  certificateTemplateIds: string[],
  imageCache: ImageCache,
): Promise<EmailAttachment[]> {
  const registration = await getRegistrationForCertificateGeneration(
    registrationId,
  );
  if (!registration) {
    throw new Error(
      "Registration not found while generating certificate attachments",
    );
  }

  const templates = await getActiveImageReadyCertificateTemplatesByIds(
    certificateTemplateIds,
    registration.event.id,
  );
  if (templates.length < certificateTemplateIds.length) {
    throw new Error(
      "Queued certificate templates are no longer active for this registration event",
    );
  }

  return generateCertificateAttachments(
    registration,
    toCertificateTemplateData(templates),
    imageCache,
  );
}

/** H2: abstract-shaped counterpart — re-fetches the abstract instead of a
 * registration, re-validates templates against the abstract's event. */
async function generateAbstractCertificateEmailAttachments(
  abstractId: string,
  certificateTemplateIds: string[],
  imageCache: ImageCache,
): Promise<EmailAttachment[]> {
  const abstract = await getAbstractForCertificateGeneration(abstractId);
  if (!abstract) {
    throw new Error(
      "Abstract not found while generating certificate attachments",
    );
  }

  const templates = await getActiveImageReadyCertificateTemplatesByIds(
    certificateTemplateIds,
    abstract.event.id,
  );
  if (templates.length < certificateTemplateIds.length) {
    throw new Error(
      "Queued certificate templates are no longer active for this abstract's event",
    );
  }

  return generateAbstractCertificateAttachments(
    abstract,
    toCertificateTemplateData(templates),
    imageCache,
  );
}

export const generateCertificateEmailAttachments: CertificateAttachmentGenerator =
  async (ctx: CertificateAttachmentContext): Promise<EmailAttachment[]> => {
    const imageCache = ctx.imageCache as ImageCache;

    if (ctx.abstractId) {
      return generateAbstractCertificateEmailAttachments(
        ctx.abstractId,
        ctx.certificateTemplateIds,
        imageCache,
      );
    }
    if (!ctx.registrationId) {
      throw new Error(
        "Certificate attachment context has neither registrationId nor abstractId",
      );
    }
    return generateRegistrationCertificateEmailAttachments(
      ctx.registrationId,
      ctx.certificateTemplateIds,
      imageCache,
    );
  };

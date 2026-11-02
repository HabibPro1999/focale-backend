// =============================================================================
// SERVER-SIDE CERTIFICATE PDF GENERATION (framework-free)
// Ported from the legacy certificate-pdf.service.ts. Lives in @app/integrations
// because the worker email queue renders certificate attachments here (via the
// injected CertificateAttachmentGenerator seam in ./email/queue). Depends only
// on db/shared/contracts and ./certificate-pdf-layout, which draws the page
// (pdf-lib/fontkit/color-name + the storage provider).
// =============================================================================

import type { CertificateZone, LanguageCode } from "@app/contracts";
import { ABSTRACT_FINAL_TYPE_LABELS } from "@app/contracts";
import { getAbstractTitle } from "@app/shared";
import {
  getRegistrationForCertificateGeneration,
  getAbstractForCertificateGeneration,
  getActiveImageReadyCertificateTemplatesByIds,
  type CertificateTemplateWithAccess,
} from "@app/db";
import {
  generateCertificatePdf,
  hexToRgb,
  truncateTextToWidth,
} from "./certificate-pdf-layout";
import { logger } from "./logger";
import { formatDate } from "./email/rendering/locale";
import type { EmailAttachment } from "./email/index";
import type {
  CertificateAttachmentContext,
  CertificateAttachmentGenerator,
} from "./email/index";

export { generateCertificatePdf } from "./certificate-pdf-layout";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificateTemplateData {
  id: string;
  name: string;
  templateUrl: string;
  templateWidth: number;
  templateHeight: number;
  /** Storage key of the render image (3.8); null until uploaded or backfilled. */
  renderImageKey: string | null;
  zones: CertificateZone[];
  applicableRoles: string[];
  accessId: string | null;
  access: { id: string; name: string } | null;
  // H2: registration-vs-abstract scoping (see isEligibleForCertificate /
  // isAbstractEligibleForCertificate below).
  scope: string;
  allowedAbstractFinalTypes: string[] | null;
}

/** The send route's and the worker's templates as certificate data. */
export function toCertificateTemplateData(
  templates: CertificateTemplateWithAccess[],
): CertificateTemplateData[] {
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    templateUrl: t.templateUrl,
    templateWidth: t.templateWidth,
    templateHeight: t.templateHeight,
    renderImageKey: t.renderImageKey,
    zones: t.zones ?? [],
    applicableRoles: t.applicableRoles ?? [],
    accessId: t.accessId,
    access: t.access ? { id: t.access.id, name: t.access.name } : null,
    scope: t.scope,
    allowedAbstractFinalTypes: t.allowedAbstractFinalTypes ?? null,
  }));
}

export interface RegistrationForCertificate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  checkedInAt: Date | null;
  accessCheckIns: Array<{ accessId: string }>;
  /** Primary language of the registration's form. */
  language: LanguageCode;
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
  /** Primary language of the event's abstract config. */
  language: LanguageCode;
  event: {
    name: string;
    startDate: Date;
    location: string | null;
  };
}

// =============================================================================
// VARIABLE RESOLUTION
// =============================================================================

/** Zone text is drawn with pdf-lib's plain drawText, which does no bidi
 * reordering: an ar-TN date ("24 سبتمبر 2026") would print its numbers
 * reversed (2026 as 6202). Arabic-primary events therefore get French dates on
 * certificates; their emails still use ar-TN. */
function certificateDateLanguage(language: LanguageCode): LanguageCode {
  return language === "ar" ? "fr" : language;
}

/** finalType, labeled, falling back to requestedType when not yet finalized
 * (mirrors the legacy `abstract.finalType ?? abstract.requestedType` raw
 * value this replaces — same fallback, now resolved through the shared label
 * map instead of the raw enum). */
export function labelForAbstractType(
  finalType: string | null,
  requestedType: string,
): string {
  const raw = finalType ?? requestedType;
  return ABSTRACT_FINAL_TYPE_LABELS[raw as keyof typeof ABSTRACT_FINAL_TYPE_LABELS] ?? raw;
}

/** The "role" zone variable on an abstract certificate is the presenter's
 * presentation type — but only once it's actually finalized. Unlike
 * abstractFinalType (which falls back to requestedType so there's always a
 * value to print), "role" shows "—" until finalType is set: a
 * requested-but-unfinalized type isn't an official role yet. */
function abstractRoleLabel(finalType: string | null, requestedType: string): string {
  return finalType ? labelForAbstractType(finalType, requestedType) : "—";
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
  issuanceDate?: string;
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
      return data.issuanceDate || "—";
    default:
      return "—";
  }
}

/** A registrant's zone variables (accessName is added per template). */
function registrationVariableData(
  registration: RegistrationForCertificate,
): CertificateVariableData {
  const language = certificateDateLanguage(registration.language);
  return {
    firstName: registration.firstName,
    lastName: registration.lastName,
    role: registration.role,
    eventName: registration.event.name,
    eventDate: formatDate(registration.event.startDate, language),
    eventLocation: registration.event.location,
    issuanceDate: formatDate(new Date(), language),
  };
}

/** A presenter's zone variables (H2). */
function abstractVariableData(
  abstract: AbstractForCertificate,
): CertificateVariableData {
  const language = certificateDateLanguage(abstract.language);
  return {
    firstName: abstract.authorFirstName,
    lastName: abstract.authorLastName,
    eventName: abstract.event.name,
    eventDate: formatDate(abstract.event.startDate, language),
    eventLocation: abstract.event.location,
    issuanceDate: formatDate(new Date(), language),
    abstractTitle: getAbstractTitle(abstract.content),
    abstractCode: abstract.code,
    abstractFinalType: labelForAbstractType(
      abstract.finalType,
      abstract.requestedType,
    ),
    role: abstractRoleLabel(abstract.finalType, abstract.requestedType),
  };
}

// =============================================================================
// TEST HOOKS (private helpers, for certificates-pdf.test.ts)
// =============================================================================

export const __certificatePdfTestHooks = {
  hexToRgb,
  safeFilenameSegment,
  truncateTextToWidth,
  labelForAbstractType,
  abstractRoleLabel,
  registrationVariableData,
  abstractVariableData,
};

// =============================================================================
// ELIGIBILITY CHECK
// =============================================================================

export function isEligibleForCertificate(
  registration: RegistrationForCertificate,
  template: CertificateTemplateData,
): boolean {
  // H2: scope gate — a template scoped ABSTRACT-only never applies to a
  // registration send. Default ('BOTH') keeps every existing template
  // eligible exactly as before scoping existed.
  if (template.scope !== "REGISTRATION" && template.scope !== "BOTH") {
    return false;
  }

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

/**
 * H2 abstract-path counterpart to isEligibleForCertificate: a template
 * applies to an abstract certificate send when it's scoped ABSTRACT/BOTH
 * (default 'BOTH' keeps every existing template eligible) AND, if it
 * restricts allowedAbstractFinalTypes, the abstract's finalType is in that
 * list (null/empty allow-list = unrestricted).
 */
export function isAbstractEligibleForCertificate(
  finalType: string | null,
  template: CertificateTemplateData,
): boolean {
  if (template.scope !== "ABSTRACT" && template.scope !== "BOTH") return false;

  const allowed = template.allowedAbstractFinalTypes;
  if (!allowed || allowed.length === 0) return true;

  return finalType != null && allowed.includes(finalType);
}

// =============================================================================
// GENERATE ALL CERTIFICATE ATTACHMENTS FOR ONE SUBJECT (registrant or abstract)
//
// Shared core: resolves per-template variables (accessName varies per
// template) then renders via generateCertificatePdf. Eligibility filtering is
// the caller's job — it differs per subject (role/check-in for registrations,
// none for abstracts) — this just renders whatever templates it's handed.
// =============================================================================

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

async function renderCertificateAttachments(
  templates: CertificateTemplateData[],
  baseVariableData: CertificateVariableData,
  filenameId: string,
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
      const pdfBuffer = await generateCertificatePdf(template, resolvedValues);

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
): Promise<EmailAttachment[]> {
  const eligible = templates.filter((t) =>
    isEligibleForCertificate(registration, t),
  );

  return renderCertificateAttachments(
    eligible,
    registrationVariableData(registration),
    registration.id,
    { registrationId: registration.id },
  );
}

/**
 * Abstract presenter certificates (H2). No role/check-in filter — abstracts
 * have no such state — but templates ARE gated by scope/allowedAbstractFinalTypes
 * (isAbstractEligibleForCertificate), mirroring apps/api
 * CertificatesService.planAbstractCertificates's own filtering of the same
 * template set for the same abstract.
 */
export async function generateAbstractCertificateAttachments(
  abstract: AbstractForCertificate,
  templates: CertificateTemplateData[],
): Promise<EmailAttachment[]> {
  const eligible = templates.filter((t) =>
    isAbstractEligibleForCertificate(abstract.finalType, t),
  );

  return renderCertificateAttachments(
    eligible,
    abstractVariableData(abstract),
    abstract.id,
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

async function generateRegistrationCertificateEmailAttachments(
  registrationId: string,
  certificateTemplateIds: string[],
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
  );
}

/** H2: abstract-shaped counterpart — re-fetches the abstract instead of a
 * registration, re-validates templates against the abstract's event. */
async function generateAbstractCertificateEmailAttachments(
  abstractId: string,
  certificateTemplateIds: string[],
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
  );
}

export const generateCertificateEmailAttachments: CertificateAttachmentGenerator =
  async (ctx: CertificateAttachmentContext): Promise<EmailAttachment[]> => {
    if (ctx.abstractId) {
      return generateAbstractCertificateEmailAttachments(
        ctx.abstractId,
        ctx.certificateTemplateIds,
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
    );
  };

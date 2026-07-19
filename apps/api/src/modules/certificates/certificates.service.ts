import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { ErrorCodes, ABSTRACT_FINAL_TYPE_LABELS } from "@app/contracts";
import type {
  CreateCertificateTemplateInput,
  UpdateCertificateTemplateInput,
} from "@app/contracts";
import {
  listCertificateTemplates,
  getCertificateTemplateWithEvent,
  getCertificateTemplateImageState,
  getCertificateTemplateForDelete,
  getCertificateTemplateForUpload,
  createCertificateTemplate,
  updateCertificateTemplate,
  updateCertificateTemplateImage,
  deleteCertificateTemplateById,
  listActiveImageReadyCertificateTemplates,
  getRegistrationsForCertificateSend,
  getAlreadySentCertTemplateIds,
  getTemplateByTrigger,
  createEmailLogsBulk,
  getAbstractsForCertificateSend,
  getAlreadySentAbstractCertTemplateIds,
  type CertificateTemplateWithAccess,
  type CertificateTemplateWithEvent,
  type EmailLogInsert,
  type AbstractForCertificateSend,
} from "@app/db";
import {
  extractStorageKeyFromUrl,
  getStorageProvider,
  buildEmailContextWithAccess,
  isEligibleForCertificate,
  isAbstractEligibleForCertificate,
  type DownloadedFile,
  type CertificateTemplateData,
} from "@app/integrations";
import { logger } from "../../core/logger.service";
import { AppException } from "../../core/app-exception";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

// Build email contexts 10-at-a-time to limit DB pressure (each does its own reads).
const CONTEXT_CONCURRENCY = 10;

interface SendEventContext {
  id: string;
  clientId: string;
}

export interface SendCertificatesResult {
  success: true;
  queued: number;
  skipped: number;
  total: number;
  breakdown: Record<string, number>;
  // H2: only present when the request included abstractIds (undefined = no
  // abstract certificates were requested, distinct from "requested but none
  // eligible").
  abstracts?: AbstractCertificateSendSummary;
}

interface BulkCertificateInput {
  registrationId: string;
  recipientEmail: string;
  recipientName?: string;
  certificateTemplateIds: string[];
  certificateNames: string[];
  contextSnapshot: Record<string, unknown>;
}

// ============================================================================
// Abstract certificates (H2) — reuses the same CERTIFICATE_SENT email
// template + active/image-ready certificate templates as the registration
// flow above; only eligibility (ACCEPTED + presentedAt != null), recipient
// (first/corresponding author), and per-abstract dedupe differ.
// ============================================================================

export type AbstractCertificateSendStatus =
  | "queued"
  | "already_sent"
  | "ineligible";

export interface AbstractCertificateSendResult {
  abstractId: string;
  status: AbstractCertificateSendStatus;
  reason?: string;
}

export interface AbstractCertificateSendSummary {
  queued: number;
  skipped: number;
  total: number;
  results: AbstractCertificateSendResult[];
}

/** Mirrors the local `getTitle` helper in abstracts.admin.service.ts — title
 * lives in the free-form `content` jsonb, not a dedicated column. */
function getAbstractTitle(content: unknown): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

/** Null = eligible. Otherwise the reason to report back for this abstractId. */
function ineligibilityReason(
  abstract: AbstractForCertificateSend | undefined,
  eventId: string,
): string | null {
  if (!abstract || abstract.eventId !== eventId) {
    return "Abstract not found for this event";
  }
  if (abstract.status !== "ACCEPTED") {
    return "Abstract is not ACCEPTED";
  }
  if (!abstract.presentedAt) {
    return "Abstract has not been marked as presented";
  }
  return null;
}

// Bare keys (no "://") are rejected: certificate templateUrls are always full
// URLs and downloadTemplateImage must 400 on anything else (legacy parity).
function extractKeyFromStorage(url: string): string | null {
  return url.includes("://") ? extractStorageKeyFromUrl(url) : null;
}

@Injectable()
export class CertificatesService {
  // ==========================================================================
  // Reads
  // ==========================================================================

  listTemplates(eventId: string): Promise<CertificateTemplateWithAccess[]> {
    return listCertificateTemplates(eventId);
  }

  /** Loads template + access + event {clientId,status}; 404 if missing. */
  async getTemplate(id: string): Promise<CertificateTemplateWithEvent> {
    const template = await getCertificateTemplateWithEvent(id);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Certificate template not found",
        404,
      );
    }
    return template;
  }

  /** Proxy download: resolve storage key, fetch bytes. 400 bad location / 404 missing. */
  async downloadTemplateImage(templateUrl: string): Promise<DownloadedFile> {
    const key = extractKeyFromStorage(templateUrl);
    if (!key) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Certificate template image is not stored in a supported location",
        400,
      );
    }

    try {
      return await getStorageProvider().download(key);
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Certificate template image not found in storage",
          404,
        );
      }
      throw err;
    }
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  /** Create a template. `active` unset → schema default true applies (legacy gotcha). */
  createTemplate(
    eventId: string,
    input: CreateCertificateTemplateInput,
  ): Promise<CertificateTemplateWithAccess> {
    return createCertificateTemplate({
      eventId,
      name: input.name,
      applicableRoles: input.applicableRoles ?? [],
      accessId: input.accessId ?? null,
      scope: input.scope,
      allowedAbstractFinalTypes: input.allowedAbstractFinalTypes,
    });
  }

  /** Update a template. Reads current row only when activating (image guard). */
  async updateTemplate(
    id: string,
    input: UpdateCertificateTemplateInput,
  ): Promise<CertificateTemplateWithAccess> {
    // Fetch current state only when needed to validate activation.
    if (input.active === true) {
      const current = await getCertificateTemplateImageState(id);
      if (!current?.templateUrl) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "Cannot activate a certificate template without an uploaded image",
          400,
        );
      }
    }

    const patch: {
      name?: string;
      zones?: unknown;
      applicableRoles?: string[];
      active?: boolean;
      accessId?: string | null;
      scope?: string;
      allowedAbstractFinalTypes?: string[] | null;
    } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.zones !== undefined) patch.zones = input.zones;
    if (input.applicableRoles !== undefined) {
      patch.applicableRoles = input.applicableRoles;
    }
    if (input.active !== undefined) patch.active = input.active;
    if (input.accessId !== undefined) patch.accessId = input.accessId;
    if (input.scope !== undefined) patch.scope = input.scope;
    if (input.allowedAbstractFinalTypes !== undefined) {
      patch.allowedAbstractFinalTypes = input.allowedAbstractFinalTypes;
    }

    return updateCertificateTemplate(id, patch);
  }

  /** Delete a template + its stored image (image delete is best-effort). */
  async deleteTemplate(id: string): Promise<void> {
    const template = await getCertificateTemplateForDelete(id);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Certificate template not found",
        404,
      );
    }

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

    await deleteCertificateTemplateById(id);
  }

  /**
   * Upload a template image. Sniffs magic bytes (never trusts Content-Type),
   * deletes any old image (best-effort), stores at ORIGINAL resolution (sharp is
   * read-only metadata here — print quality), persists url + dimensions.
   */
  async uploadTemplateImage(
    id: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<CertificateTemplateWithAccess> {
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Only PNG and JPEG images are allowed",
        400,
      );
    }

    const template = await getCertificateTemplateForUpload(id);
    if (!template) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Certificate template not found",
        404,
      );
    }

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

    const metadata = await sharp(file.buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    const ext = MIME_TO_EXT[detected.mime] ?? "png";
    const key = `${template.eventId}/certificates/${template.id}.${ext}`;
    const templateUrl = await getStorageProvider().uploadPublic(
      file.buffer,
      key,
      detected.mime,
    );

    return updateCertificateTemplateImage(id, {
      templateUrl,
      templateWidth: width,
      templateHeight: height,
    });
  }

  // ==========================================================================
  // Send (bulk-queue certificate emails)
  // ==========================================================================

  async sendCertificates(
    event: SendEventContext,
    registrationIds: string[] | undefined,
    abstractIds?: string[],
  ): Promise<SendCertificatesResult> {
    // H2: abstractIds is a new, additive field on an existing endpoint. When
    // it's present but registrationIds was omitted, the caller is invoking
    // the new abstract-certificate action and did not ask to also blast every
    // registrant — narrow registrations to "none" instead of the legacy
    // "undefined = all" default. Any caller who omits abstractIds entirely
    // (i.e. every pre-existing caller) is completely unaffected.
    const effectiveRegistrationIds =
      abstractIds !== undefined && registrationIds === undefined
        ? []
        : registrationIds;

    // 1. CERTIFICATE_SENT email template must be configured.
    const emailTemplate = await getTemplateByTrigger(event.id, "CERTIFICATE_SENT");
    if (!emailTemplate) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "No CERTIFICATE_SENT email template configured for this event. Create one in the Email Templates section first.",
        400,
      );
    }

    // 2. Active, image-ready certificate templates.
    const certTemplates = await listActiveImageReadyCertificateTemplates(event.id);
    if (certTemplates.length === 0) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "No active certificate templates found for this event.",
        400,
      );
    }

    // 3. Target registrations (undefined = all; empty array = none).
    const registrations = await getRegistrationsForCertificateSend(
      event.id,
      effectiveRegistrationIds,
    );

    // Build template data once — same for all registrants.
    const templateData: CertificateTemplateData[] = certTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      templateUrl: t.templateUrl,
      templateWidth: t.templateWidth,
      templateHeight: t.templateHeight,
      zones: (t.zones as CertificateTemplateData["zones"]) ?? [],
      applicableRoles: (t.applicableRoles as string[] | null) ?? [],
      accessId: t.accessId,
      access: t.access ? { id: t.access.id, name: t.access.name } : null,
      scope: t.scope,
      allowedAbstractFinalTypes: (t.allowedAbstractFinalTypes as string[] | null) ?? null,
    }));

    // 4. Filter to registrations with ≥1 eligible template (pure, no I/O).
    const eligibleRegs = registrations
      .map((reg) => {
        const eligible = templateData.filter((t) =>
          isEligibleForCertificate(
            {
              id: reg.id,
              firstName: reg.firstName,
              lastName: reg.lastName,
              role: reg.role,
              checkedInAt: reg.checkedInAt,
              accessCheckIns: reg.accessCheckIns,
              event: {
                name: reg.event.name,
                startDate: reg.event.startDate,
                location: reg.event.location,
              },
            },
            t,
          ),
        );
        return { reg, eligible };
      })
      .filter(({ eligible }) => eligible.length > 0);

    // 5. Build email contexts in batches of CONTEXT_CONCURRENCY.
    const inputs: BulkCertificateInput[] = [];
    const breakdown: Record<string, number> = {};

    for (let i = 0; i < eligibleRegs.length; i += CONTEXT_CONCURRENCY) {
      const chunk = eligibleRegs.slice(i, i + CONTEXT_CONCURRENCY);
      const contexts = await Promise.all(
        chunk.map(({ reg }) => buildEmailContextWithAccess(reg)),
      );

      for (let j = 0; j < chunk.length; j++) {
        const { reg, eligible } = chunk[j];
        const context = contexts[j];

        for (const t of eligible) {
          breakdown[t.name] = (breakdown[t.name] || 0) + 1;
        }

        inputs.push({
          registrationId: reg.id,
          recipientEmail: reg.email,
          recipientName:
            [reg.firstName, reg.lastName].filter(Boolean).join(" ") || undefined,
          certificateTemplateIds: eligible.map((t) => t.id),
          certificateNames: eligible.map((t) => t.name),
          contextSnapshot: context as unknown as Record<string, unknown>,
        });
      }
    }

    // 6. Queue all emails (per-template dedup against already-queued/sent).
    const { queued, skipped } = await this.queueBulkCertificateEmails(
      emailTemplate.id,
      inputs,
    );

    logger.info(
      { eventId: event.id, queued, skipped, total: registrations.length, breakdown },
      "Certificate emails queued",
    );

    const result: SendCertificatesResult = {
      success: true,
      queued,
      skipped,
      total: registrations.length,
      breakdown,
    };

    // 7. Abstract presenter certificates (H2) — only when requested.
    if (abstractIds !== undefined) {
      result.abstracts = await this.processAbstractCertificates(
        event,
        emailTemplate.id,
        templateData,
        abstractIds,
      );
      logger.info(
        { eventId: event.id, ...result.abstracts },
        "Abstract certificate emails queued",
      );
    }

    return result;
  }

  /**
   * Insert one QUEUED EmailLog per registrant, deduping template ids against
   * already-queued/sent certs. A registrant is skipped only when ALL their
   * eligible templates were already covered. `_certificateTemplateIds` is the
   * durable dedup key + the templates the worker attaches at send time.
   */
  private async queueBulkCertificateEmails(
    emailTemplateId: string,
    inputs: BulkCertificateInput[],
  ): Promise<{ queued: number; skipped: number }> {
    if (inputs.length === 0) return { queued: 0, skipped: 0 };

    const sentMap = await getAlreadySentCertTemplateIds(
      inputs.map((i) => i.registrationId),
    );

    let skipped = 0;
    const values: EmailLogInsert[] = [];

    for (const input of inputs) {
      const alreadySent = sentMap.get(input.registrationId) ?? new Set<string>();
      const remainingIds: string[] = [];
      const remainingNames: string[] = [];
      input.certificateTemplateIds.forEach((templateId, index) => {
        if (!alreadySent.has(templateId)) {
          remainingIds.push(templateId);
          remainingNames.push(input.certificateNames[index]);
        }
      });

      if (remainingIds.length === 0) {
        skipped++;
        continue;
      }

      values.push({
        trigger: "CERTIFICATE_SENT",
        templateId: emailTemplateId,
        registrationId: input.registrationId,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName ?? null,
        subject: "",
        status: "QUEUED",
        contextSnapshot: {
          ...input.contextSnapshot,
          certificateCount: String(remainingIds.length),
          certificateList: remainingNames.join(", "),
          _certificateTemplateIds: remainingIds,
        },
      });
    }

    const queued = await createEmailLogsBulk(values);
    return { queued, skipped };
  }

  /**
   * Abstract presenter certificates (H2). Reuses the event's active,
   * image-ready certificate templates and CERTIFICATE_SENT email template,
   * narrowed per-abstract to those scoped ABSTRACT/BOTH whose
   * allowedAbstractFinalTypes (if any) includes the abstract's finalType
   * (isAbstractEligibleForCertificate). Per-id eligibility: must belong to
   * the event, be ACCEPTED, have presentedAt != null (set by
   * markAbstractPresented), and have ≥1 applicable template. Ineligible /
   * already-sent ids are reported individually rather than failing the
   * whole request. Recipient is the abstract's author (first/corresponding
   * author — abstracts have exactly one author on file).
   */
  private async processAbstractCertificates(
    event: SendEventContext,
    emailTemplateId: string,
    certTemplates: CertificateTemplateData[],
    abstractIds: string[],
  ): Promise<AbstractCertificateSendSummary> {
    const uniqueIds = Array.from(new Set(abstractIds));
    if (uniqueIds.length === 0) {
      return { queued: 0, skipped: 0, total: 0, results: [] };
    }

    const found = await getAbstractsForCertificateSend(event.id, uniqueIds);
    const byId = new Map(found.map((a) => [a.id, a]));

    const eligibleIds = uniqueIds.filter(
      (id) => ineligibilityReason(byId.get(id), event.id) === null,
    );
    const alreadySent = await getAlreadySentAbstractCertTemplateIds(eligibleIds);

    const results: AbstractCertificateSendResult[] = [];
    const values: EmailLogInsert[] = [];

    for (const id of uniqueIds) {
      const maybeAbstract = byId.get(id);
      const reason = ineligibilityReason(maybeAbstract, event.id);
      if (reason) {
        results.push({ abstractId: id, status: "ineligible", reason });
        continue;
      }
      // reason === null guarantees ineligibilityReason found a defined,
      // event-scoped abstract (see its implementation above).
      const abstract = maybeAbstract as AbstractForCertificateSend;

      // H2: scope + allowedAbstractFinalTypes gate — narrow to templates that
      // actually apply to this abstract before the dedupe check below.
      const applicableTemplates = certTemplates.filter((t) =>
        isAbstractEligibleForCertificate(abstract.finalType, t),
      );
      if (applicableTemplates.length === 0) {
        results.push({
          abstractId: id,
          status: "ineligible",
          reason: "No certificate templates apply to this abstract",
        });
        continue;
      }

      const sentIds = alreadySent.get(id) ?? new Set<string>();
      const remaining = applicableTemplates.filter((t) => !sentIds.has(t.id));
      if (remaining.length === 0) {
        results.push({ abstractId: id, status: "already_sent" });
        continue;
      }

      const authorName = [abstract.authorFirstName, abstract.authorLastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      const abstractType = abstract.finalType ?? abstract.requestedType;

      values.push({
        trigger: "CERTIFICATE_SENT",
        templateId: emailTemplateId,
        abstractId: id,
        recipientEmail: abstract.authorEmail,
        recipientName: authorName || null,
        subject: "",
        status: "QUEUED",
        contextSnapshot: {
          certificateCount: String(remaining.length),
          certificateList: remaining.map((t) => t.name).join(", "),
          _certificateTemplateIds: remaining.map((t) => t.id),
          fullName: authorName || "—",
          abstractTitle: getAbstractTitle(abstract.content),
          abstractCode: abstract.code ?? "—",
          abstractFinalType:
            ABSTRACT_FINAL_TYPE_LABELS[
              abstractType as keyof typeof ABSTRACT_FINAL_TYPE_LABELS
            ] ?? abstractType,
          eventName: abstract.event.name,
          eventDate: abstract.event.startDate.toISOString(),
          eventLocation: abstract.event.location ?? "—",
          issuanceDate: new Date().toISOString(),
        },
      });
      results.push({ abstractId: id, status: "queued" });
    }

    const queued = await createEmailLogsBulk(values);
    const skipped = results.filter((r) => r.status !== "queued").length;

    return { queued, skipped, total: uniqueIds.length, results };
  }
}

import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { ErrorCodes, ABSTRACT_FINAL_TYPE_LABELS } from "@app/contracts";
import { getAbstractTitle } from "@app/shared";
import type {
  CreateCertificateTemplateInput,
  UpdateCertificateTemplateInput,
} from "@app/contracts";
import {
  listCertificateTemplates,
  getCertificateTemplateWithEvent,
  getCertificateTemplateImageState,
  findExistingAccessIdsInEvent,
  getCertificateTemplateForDelete,
  getCertificateTemplateForUpload,
  createCertificateTemplate,
  updateCertificateTemplate,
  updateCertificateTemplateImage,
  deleteCertificateTemplateById,
  getDb,
  listActiveImageReadyCertificateTemplates,
  getRegistrationsForCertificateSend,
  getAlreadySentCertTemplateIds,
  getTemplateByTrigger,
  getAbstractsForCertificateSend,
  queueCertificateEmailLogsTxn,
  type CertificateTemplateWithAccess,
  type CertificateTemplateWithEvent,
  type CertificateEmailCandidate,
  type CertificateEmailOutcome,
  type AbstractForCertificateSend,
} from "@app/db";
import {
  IMAGE_INPUT_LIMITS,
  extractStorageKeyFromUrl,
  getStorageProvider,
  ownedStorageKey,
  buildEmailContextWithAccess,
  loadEmailContextLookups,
  deriveCertificateRenderImage,
  certificateRenderImageKey,
  isEligibleForCertificate,
  isAbstractEligibleForCertificate,
  StorageObjectNotFoundError,
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

// Build email contexts 10-at-a-time to limit DB pressure (a registrant with a
// sponsorship code still reads it).
const CONTEXT_CONCURRENCY = 10;

const INVALID_TEMPLATE_IMAGE_MESSAGE =
  "Invalid image. Upload a valid PNG or JPEG of at most 20 megapixels.";

interface SendEventContext {
  id: string;
  clientId: string;
}

export interface SendCertificatesResult {
  success: true;
  queued: number;
  /** Registrations not queued: already sent, or refused by a unique index. */
  skipped: number;
  /** The part of `skipped` that a unique index refused (2.12). */
  skippedConflict: number;
  total: number;
  breakdown: Record<string, number>;
  // H2: only present when the request included abstractIds (undefined = no
  // abstract certificates were requested, distinct from "requested but none
  // eligible").
  abstracts?: AbstractCertificateSendSummary;
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
  // 2.12: a unique index refused the email row; nothing was queued.
  | "skipped_conflict"
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

async function deleteCertificateImageBestEffort(key: string): Promise<void> {
  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    logger.warn({ err, key }, "Failed to delete certificate image");
  }
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
    // Bare keys are rejected: certificate templateUrls are always full URLs
    // and this must 400 on anything else (legacy parity).
    const key = extractStorageKeyFromUrl(templateUrl, { allowBareKey: false });
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
      if (err instanceof StorageObjectNotFoundError) {
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
  async createTemplate(
    eventId: string,
    input: CreateCertificateTemplateInput,
  ): Promise<CertificateTemplateWithAccess> {
    if (input.accessId != null) {
      await this.assertAccessBelongsToEvent(input.accessId, eventId);
    }

    return createCertificateTemplate({
      eventId,
      name: input.name,
      applicableRoles: input.applicableRoles ?? [],
      accessId: input.accessId ?? null,
      scope: input.scope,
      allowedAbstractFinalTypes: input.allowedAbstractFinalTypes,
    }, getDb());
  }

  private async assertAccessBelongsToEvent(
    accessId: string,
    eventId: string,
  ): Promise<void> {
    const matchingIds = await findExistingAccessIdsInEvent([accessId], eventId);
    if (!matchingIds.includes(accessId)) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Certificate access item must belong to the template's event",
        400,
      );
    }
  }

  /** Update a template. Reads current state when activating or linking access. */
  async updateTemplate(
    id: string,
    input: UpdateCertificateTemplateInput,
  ): Promise<CertificateTemplateWithAccess> {
    // Fetch current event and image state only when the patch needs validation.
    let current: Awaited<
      ReturnType<typeof getCertificateTemplateImageState>
    > = null;
    if (input.active === true || input.accessId != null) {
      current = await getCertificateTemplateImageState(id);
    }
    if (input.active === true) {
      if (!current?.templateUrl) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "Cannot activate a certificate template without an uploaded image",
          400,
        );
      }
    }
    if (input.accessId != null) {
      if (!current) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          "Certificate template not found",
          404,
        );
      }
      await this.assertAccessBelongsToEvent(input.accessId, current.eventId);
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

    return updateCertificateTemplate(id, patch, getDb());
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
      const key = extractStorageKeyFromUrl(template.templateUrl, {
        allowBareKey: false,
      });
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
    // 3.8: the render image, only when it lies under this event's prefix.
    const renderKey = ownedStorageKey(
      template.renderImageKey,
      `${template.eventId}/certificates`,
    );
    if (renderKey) await deleteCertificateImageBestEffort(renderKey);

    await deleteCertificateTemplateById(id, getDb());
  }

  /**
   * Upload a template image. Sniffs magic bytes (never trusts Content-Type),
   * stores the original under a fresh key (its pixel size is the certificate
   * page size) plus the render image derived from it (3.8: a flattened JPEG,
   * at most 3508 px, that the worker embeds), persists url + dimensions +
   * render image, then deletes the old images (best-effort) once the row
   * points at the new ones.
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

    // Header-only read, but it enforces the pixel limit before anything is
    // decoded or stored. The original's pixel size is the certificate page size.
    const metadata = await sharp(file.buffer, IMAGE_INPUT_LIMITS)
      .metadata()
      .catch(() => {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          INVALID_TEMPLATE_IMAGE_MESSAGE,
          400,
        );
      });
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    // 3.8: the one full decode, under the same limits; an image that cannot
    // be decoded is refused here instead of failing every certificate later.
    const render = await deriveCertificateRenderImage(file.buffer).catch(() => {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        INVALID_TEMPLATE_IMAGE_MESSAGE,
        400,
      );
    });

    const ext = MIME_TO_EXT[detected.mime] ?? "png";
    const ownedPrefix = `${template.eventId}/certificates`;
    // A fresh key per upload: the image the row points at (served with a
    // year-long public cache, and cached by key in the worker) is never
    // overwritten. The render image sits beside it.
    const imageId = randomUUID();
    const key = `${ownedPrefix}/${template.id}-${imageId}.${ext}`;
    const renderKey = certificateRenderImageKey(template.eventId, template.id, imageId);
    const storage = getStorageProvider();
    const templateUrl = await storage.uploadPublic(
      file.buffer,
      key,
      detected.mime,
    );
    try {
      await storage.uploadPrivate(render.buffer, renderKey, render.contentType);
    } catch (err) {
      await deleteCertificateImageBestEffort(key);
      throw err;
    }
    const removeNewImages = async () => {
      await deleteCertificateImageBestEffort(key);
      await deleteCertificateImageBestEffort(renderKey);
    };

    // Typed non-null, but the reload yields null when the row is gone.
    let updated: CertificateTemplateWithAccess | null;
    try {
      updated = await updateCertificateTemplateImage(id, {
        templateUrl,
        templateWidth: width,
        templateHeight: height,
        renderImageKey: renderKey,
        renderImageWidth: render.width,
        renderImageHeight: render.height,
      }, getDb());
    } catch (err) {
      await removeNewImages();
      throw err;
    }
    if (!updated) {
      // The template was deleted while the image was uploading.
      await removeNewImages();
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Certificate template not found",
        404,
      );
    }

    if (template.templateUrl && template.templateUrl !== templateUrl) {
      const oldKey = ownedStorageKey(template.templateUrl, ownedPrefix);
      if (oldKey) {
        await deleteCertificateImageBestEffort(oldKey);
      } else {
        logger.warn(
          { templateId: id, url: template.templateUrl },
          "Old certificate image is outside the event's storage prefix; not deleting",
        );
      }
    }
    if (template.renderImageKey && template.renderImageKey !== renderKey) {
      const oldRenderKey = ownedStorageKey(template.renderImageKey, ownedPrefix);
      if (oldRenderKey) await deleteCertificateImageBestEffort(oldRenderKey);
    }
    return updated;
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
      renderImageKey: t.renderImageKey,
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

    // 5. Dedupe read before any context is built (3.8): a registration whose
    // eligible certificates were all queued or sent already costs no context.
    // Not locking; queueCertificateEmailLogsTxn re-reads under the event lock
    // and stays the authority for what gets queued.
    const sentBefore = await getAlreadySentCertTemplateIds(
      eligibleRegs.map(({ reg }) => reg.id),
    );
    const regsToQueue = eligibleRegs.filter(({ reg, eligible }) => {
      const sent = sentBefore.get(reg.id);
      return !sent || eligible.some((t) => !sent.has(t.id));
    });
    const alreadySentBefore = eligibleRegs.length - regsToQueue.length;

    // 6. Build email contexts in batches of CONTEXT_CONCURRENCY; the event's
    // pricing and the access items are read once for the whole send.
    const registrationCandidates: CertificateEmailCandidate[] = [];
    const contextLookups =
      regsToQueue.length > 0
        ? await loadEmailContextLookups(
            event.id,
            regsToQueue.flatMap(({ reg }) => reg.accessTypeIds ?? []),
          )
        : undefined;

    for (let i = 0; i < regsToQueue.length; i += CONTEXT_CONCURRENCY) {
      const chunk = regsToQueue.slice(i, i + CONTEXT_CONCURRENCY);
      const contexts = await Promise.all(
        chunk.map(({ reg }) => buildEmailContextWithAccess(reg, contextLookups)),
      );

      for (let j = 0; j < chunk.length; j++) {
        const { reg, eligible } = chunk[j];
        registrationCandidates.push({
          targetId: reg.id,
          recipientEmail: reg.email,
          recipientName:
            [reg.firstName, reg.lastName].filter(Boolean).join(" ") || null,
          certificates: eligible.map((t) => ({ id: t.id, name: t.name })),
          contextSnapshot: contexts[j] as unknown as Record<string, unknown>,
        });
      }
    }

    // 7. Abstract presenter certificates (H2) — only when requested.
    const abstractPlan =
      abstractIds !== undefined
        ? await this.planAbstractCertificates(event, templateData, abstractIds)
        : undefined;

    // 8. Queue both batches in one transaction, under the event lock, deduped
    // per certificate template against what is already queued or sent.
    const outcomes = await queueCertificateEmailLogsTxn({
      eventId: event.id,
      emailTemplateId: emailTemplate.id,
      registrations: registrationCandidates,
      abstracts: abstractPlan?.candidates ?? [],
    });
    if (!outcomes) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    let queued = 0;
    let alreadySent = alreadySentBefore;
    let skippedConflict = 0;
    const breakdown: Record<string, number> = {};
    for (const outcome of outcomes.registrations) {
      if (outcome.status === "queued") {
        queued++;
        for (const certificate of outcome.certificates) {
          breakdown[certificate.name] = (breakdown[certificate.name] || 0) + 1;
        }
      } else if (outcome.status === "already_sent") {
        alreadySent++;
      } else {
        skippedConflict++;
      }
    }

    const result: SendCertificatesResult = {
      success: true,
      queued,
      skipped: alreadySent + skippedConflict,
      skippedConflict,
      total: registrations.length,
      breakdown,
    };
    logger.info(
      { eventId: event.id, queued, alreadySent, skippedConflict, total: registrations.length, breakdown },
      "Certificate emails queued",
    );

    if (abstractPlan) {
      result.abstracts = abstractPlan.summarize(outcomes.abstracts);
      logger.info(
        {
          eventId: event.id,
          queued: result.abstracts.queued,
          skipped: result.abstracts.skipped,
          total: result.abstracts.total,
        },
        "Abstract certificate emails queued",
      );
    }

    return result;
  }

  /**
   * Abstract presenter certificates (H2). Reuses the event's active,
   * image-ready certificate templates and CERTIFICATE_SENT email template,
   * narrowed per-abstract to those scoped ABSTRACT/BOTH whose
   * allowedAbstractFinalTypes (if any) includes the abstract's finalType
   * (isAbstractEligibleForCertificate). Per-id eligibility: must belong to
   * the event, be ACCEPTED, have presentedAt != null (set by
   * markAbstractPresented), and have ≥1 applicable template. Ineligible ids
   * are reported individually rather than failing the whole request; the
   * already-sent check happens in the queueing transaction. Recipient is the
   * abstract's author (first/corresponding author — abstracts have exactly
   * one author on file).
   */
  private async planAbstractCertificates(
    event: SendEventContext,
    certTemplates: CertificateTemplateData[],
    abstractIds: string[],
  ): Promise<{
    candidates: CertificateEmailCandidate[];
    summarize: (outcomes: CertificateEmailOutcome[]) => AbstractCertificateSendSummary;
  }> {
    const uniqueIds = Array.from(new Set(abstractIds));
    const found =
      uniqueIds.length > 0
        ? await getAbstractsForCertificateSend(event.id, uniqueIds)
        : [];
    const byId = new Map(found.map((a) => [a.id, a]));

    // Per input id: a final (ineligible) result, or the index of its candidate.
    const slots: Array<AbstractCertificateSendResult | number> = [];
    const candidates: CertificateEmailCandidate[] = [];

    for (const id of uniqueIds) {
      const maybeAbstract = byId.get(id);
      const reason = ineligibilityReason(maybeAbstract, event.id);
      if (reason) {
        slots.push({ abstractId: id, status: "ineligible", reason });
        continue;
      }
      // reason === null guarantees ineligibilityReason found a defined,
      // event-scoped abstract (see its implementation above).
      const abstract = maybeAbstract as AbstractForCertificateSend;

      // H2: scope + allowedAbstractFinalTypes gate — narrow to templates that
      // actually apply to this abstract before the dedupe check.
      const applicableTemplates = certTemplates.filter((t) =>
        isAbstractEligibleForCertificate(abstract.finalType, t),
      );
      if (applicableTemplates.length === 0) {
        slots.push({
          abstractId: id,
          status: "ineligible",
          reason: "No certificate templates apply to this abstract",
        });
        continue;
      }

      const authorName = [abstract.authorFirstName, abstract.authorLastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      const abstractType = abstract.finalType ?? abstract.requestedType;

      slots.push(candidates.length);
      candidates.push({
        targetId: id,
        recipientEmail: abstract.authorEmail,
        recipientName: authorName || null,
        certificates: applicableTemplates.map((t) => ({ id: t.id, name: t.name })),
        contextSnapshot: {
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
    }

    const summarize = (
      outcomes: CertificateEmailOutcome[],
    ): AbstractCertificateSendSummary => {
      const results = slots.map((slot, index): AbstractCertificateSendResult =>
        typeof slot === "number"
          ? { abstractId: uniqueIds[index], status: outcomes[slot].status }
          : slot,
      );
      const queued = results.filter((r) => r.status === "queued").length;
      return {
        queued,
        skipped: results.length - queued,
        total: uniqueIds.length,
        results,
      };
    };

    return { candidates, summarize };
  }
}

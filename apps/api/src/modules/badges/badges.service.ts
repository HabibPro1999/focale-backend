import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import {
  ErrorCodes,
  seedBadgeZones,
  type BadgeTemplate,
  type CreateBadgeTemplateInput,
  type UpdateBadgeTemplateInput,
} from "@app/contracts";
import {
  createBadgeTemplate,
  deleteBadgeTemplate,
  getBadgeTemplate,
  getDb,
  getRegistrationForEmailContext,
  getRegistrationFormLanguage,
  listBadgeTemplates,
  setBadgeTemplateBackground,
  updateBadgeTemplate,
  type BadgeTemplateRow,
} from "@app/db";
import {
  badgeValuesFromContext,
  buildEmailContextWithAccess,
  deriveTemplateRenderImage,
  extractStorageKeyFromUrl,
  formatRegistrationNumber,
  generateBadgePdf,
  getAvailableVariables,
  getSampleEmailContext,
  getStorageProvider,
  IMAGE_INPUT_LIMITS,
  ownedStorageKey,
  SAMPLE_REGISTRATION_ID,
  StorageObjectNotFoundError,
  templateRenderImageKey,
  type DownloadedFile,
} from "@app/integrations";
import { logger } from "../../core/logger.service";
import { AppException } from "../../core/app-exception";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** A rendered badge and the name it is served and attached under. */
export interface BadgePdf {
  pdf: Buffer;
  filename: string;
}

function badgeNotFound(): AppException {
  return new AppException(ErrorCodes.BADGE_TEMPLATE_NOT_FOUND, "Badge not found", 404);
}

function invalidImage(message: string): AppException {
  return new AppException(ErrorCodes.BADGE_IMAGE_INVALID, message, 400);
}

/** The API shape of a row: no render-image or soft-delete columns. */
function toBadgeTemplate(row: BadgeTemplateRow): BadgeTemplate {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    backgroundUrl: row.backgroundUrl,
    backgroundWidth: row.backgroundWidth,
    backgroundHeight: row.backgroundHeight,
    zones: row.zones,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function badgeFilename(registrationId: string): string {
  return `badge-${formatRegistrationNumber(registrationId)}.pdf`;
}

async function deleteImageBestEffort(key: string): Promise<void> {
  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    logger.warn({ err, key }, "Failed to delete badge image");
  }
}

/** The stored images of a background, when they lie under the event's badge prefix. */
async function deleteBackgroundImages(row: BadgeTemplateRow): Promise<void> {
  const prefix = `${row.eventId}/badges`;
  for (const location of [row.backgroundUrl, row.renderImageKey]) {
    if (!location) continue;
    const key = ownedStorageKey(location, prefix);
    if (key) await deleteImageBestEffort(key);
    else logger.warn({ badgeTemplateId: row.id, location }, "Badge image outside the event's storage prefix; not deleting");
  }
}

@Injectable()
export class BadgesService {
  async list(eventId: string): Promise<BadgeTemplate[]> {
    return (await listBadgeTemplates(eventId)).map(toBadgeTemplate);
  }

  async get(id: string): Promise<BadgeTemplate> {
    return toBadgeTemplate(await this.load(id));
  }

  /** A new badge; without zones it starts with the seeded layout (name on top, QR centred). */
  async create(eventId: string, input: CreateBadgeTemplateInput): Promise<BadgeTemplate> {
    const row = await createBadgeTemplate({
      eventId,
      name: input.name,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      zones: input.zones ?? seedBadgeZones(input.widthMm, input.heightMm),
    }, getDb());
    return toBadgeTemplate(row);
  }

  async update(id: string, input: UpdateBadgeTemplateInput): Promise<BadgeTemplate> {
    const row = await updateBadgeTemplate(id, input, getDb());
    if (!row) throw badgeNotFound();
    return toBadgeTemplate(row);
  }

  /** Soft delete. Email templates still naming it skip the badge at send time. */
  async delete(id: string): Promise<void> {
    if (!(await deleteBadgeTemplate(id, getDb()))) throw badgeNotFound();
  }

  /**
   * Upload the background, as certificates do: sniff the magic bytes (never
   * trust Content-Type), check the pixel limit, derive the flattened JPEG
   * the renderer embeds, store both under fresh keys, point the row at them,
   * then delete the previous images (best-effort).
   */
  async uploadBackground(
    id: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<BadgeTemplate> {
    const detected = await fileTypeFromBuffer(file.buffer);
    const ext = detected ? MIME_TO_EXT[detected.mime] : undefined;
    if (!detected || !ext) throw invalidImage("Only PNG and JPEG images are allowed");

    const badge = await this.load(id);

    const invalid = () => invalidImage("Invalid image. Upload a valid PNG or JPEG of at most 20 megapixels.");
    const metadata = await sharp(file.buffer, IMAGE_INPUT_LIMITS).metadata().catch(() => {
      throw invalid();
    });
    const render = await deriveTemplateRenderImage(file.buffer).catch(() => {
      throw invalid();
    });

    const imageId = randomUUID();
    const key = `${badge.eventId}/badges/${badge.id}-${imageId}.${ext}`;
    const renderKey = templateRenderImageKey("badges", badge.eventId, badge.id, imageId);
    const storage = getStorageProvider();
    const backgroundUrl = await storage.uploadPublic(file.buffer, key, detected.mime);
    try {
      await storage.uploadPrivate(render.buffer, renderKey, render.contentType);
    } catch (err) {
      await deleteImageBestEffort(key);
      throw err;
    }
    const removeNewImages = async () => {
      await deleteImageBestEffort(key);
      await deleteImageBestEffort(renderKey);
    };

    let updated: BadgeTemplateRow | null;
    try {
      updated = await setBadgeTemplateBackground(id, {
        backgroundUrl,
        backgroundWidth: metadata.width ?? 0,
        backgroundHeight: metadata.height ?? 0,
        renderImageKey: renderKey,
        renderImageWidth: render.width,
        renderImageHeight: render.height,
      }, getDb());
    } catch (err) {
      await removeNewImages();
      throw err;
    }
    if (!updated) {
      // The badge was deleted while the image was uploading.
      await removeNewImages();
      throw badgeNotFound();
    }
    await deleteBackgroundImages(badge);
    return toBadgeTemplate(updated);
  }

  /** Remove the background (its images are deleted best-effort). */
  async removeBackground(id: string): Promise<BadgeTemplate> {
    const badge = await this.load(id);
    if (!badge.backgroundUrl && !badge.renderImageKey) return toBadgeTemplate(badge);
    const updated = await setBadgeTemplateBackground(id, null, getDb());
    if (!updated) throw badgeNotFound();
    await deleteBackgroundImages(badge);
    return toBadgeTemplate(updated);
  }

  /** The original background's bytes, for the admin canvas. */
  async downloadBackground(id: string): Promise<DownloadedFile> {
    const badge = await this.load(id);
    const key = badge.backgroundUrl
      ? extractStorageKeyFromUrl(badge.backgroundUrl, { allowBareKey: false })
      : null;
    if (!key) throw new AppException(ErrorCodes.NOT_FOUND, "Badge background not found", 404);
    try {
      return await getStorageProvider().download(key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Badge background not found in storage", 404);
      }
      throw err;
    }
  }

  /**
   * The badge for the sample registration, with the sample email values, and
   * each form field's example value from the variable catalogue (the sample
   * context has no form answers): what the admin canvas shows.
   */
  async samplePdf(id: string): Promise<BadgePdf> {
    const badge = this.renderable(await this.load(id));
    const language = await getRegistrationFormLanguage(badge.eventId);
    const formExamples = (await getAvailableVariables(badge.eventId, language))
      .filter((variable) => variable.category === "form" && variable.example)
      .map((variable) => [variable.id, variable.example ?? ""] as const);
    const values = {
      ...Object.fromEntries(formExamples),
      ...badgeValuesFromContext(getSampleEmailContext(language)),
    };
    return {
      pdf: await generateBadgePdf(badge, values, SAMPLE_REGISTRATION_ID),
      filename: badgeFilename(SAMPLE_REGISTRATION_ID),
    };
  }

  /**
   * A registrant's badge, from the same email context the badge attachment
   * reads. The badge must be one of the registration's event.
   */
  async registrationPdf(registrationId: string, badgeId: string): Promise<BadgePdf> {
    const registration = await getRegistrationForEmailContext(registrationId);
    if (!registration) {
      throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
    }
    const row = await getBadgeTemplate(badgeId);
    if (!row || row.eventId !== registration.eventId) throw badgeNotFound();
    const badge = this.renderable(row);
    const context = await buildEmailContextWithAccess(registration);
    return {
      pdf: await generateBadgePdf(badge, badgeValuesFromContext(context), registration.id),
      filename: badgeFilename(registration.id),
    };
  }

  private async load(id: string): Promise<BadgeTemplateRow> {
    const row = await getBadgeTemplate(id);
    if (!row) throw badgeNotFound();
    return row;
  }

  /** Every badge carries the check-in QR: a stored document without exactly one is not rendered. */
  private renderable(row: BadgeTemplateRow): BadgeTemplateRow {
    if (row.zones.filter((zone) => zone.kind === "qr").length !== 1) {
      throw new AppException(ErrorCodes.BADGE_QR_ZONE_REQUIRED, "The badge needs exactly one QR zone", 400);
    }
    return row;
  }
}

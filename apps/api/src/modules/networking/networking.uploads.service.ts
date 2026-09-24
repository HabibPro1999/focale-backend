import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { IMAGE_INPUT_LIMITS, getStorageProvider, ownedStorageKey } from "@app/integrations";
import { createLogger } from "@app/shared";
import type { FastifyRequest } from "fastify";
const log = createLogger({ name: "networking:uploads" });
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const invalidImage = () =>
  new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Use a valid PNG, JPEG or WebP image up to 5 MB and 20 megapixels" });
export type NetworkingMultipartRequest = FastifyRequest & {
  file(options?: {
    limits: { fileSize: number; files: number };
  }): Promise<{ toBuffer(): Promise<Buffer> } | undefined>;
};
const missing = (error: unknown) => {
  const failure = error as { code?: string | number; name?: string; $metadata?: { httpStatusCode?: number } };
  return failure?.code === 404 || failure?.code === "404" || failure?.name === "NoSuchKey" ||
    failure?.$metadata?.httpStatusCode === 404;
};
/** Best-effort: only objects under the participant's own upload prefix are ever deleted. */
export async function deleteNetworkingPhoto(
  photoUrl: string | null | undefined,
  eventId: string,
  profileId: string,
) {
  const key = ownedStorageKey(photoUrl, `networking/${eventId}/profiles/${profileId}`);
  if (!key) return;
  try {
    await getStorageProvider().delete(key);
  } catch (error) {
    if (!missing(error)) log.warn({ err: error, profileId }, "Failed to delete networking photo");
  }
}
@Injectable()
export class NetworkingUploadsService {
  deletePhoto(photoUrl: string | null | undefined, eventId: string, profileId: string) {
    return deleteNetworkingPhoto(photoUrl, eventId, profileId);
  }
  async image(
    req: NetworkingMultipartRequest,
    prefix: string,
    save: (url: string) => Promise<unknown>,
    previousUrl?: string | null,
  ) {
    const part = await req.file({
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    if (!part) throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Choose an image to upload" });
    const source = await part.toBuffer();
    // Magic bytes first: only PNG/JPEG/WebP ever reach a decoder (never SVG, GIF, TIFF...).
    const detected = await fileTypeFromBuffer(source);
    if (!detected || !IMAGE_MIME_TYPES.has(detected.mime)) throw invalidImage();
    let bytes: Buffer;
    try {
      const image = sharp(source, { ...IMAGE_INPUT_LIMITS, animated: false });
      const metadata = await image.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
        throw new Error();
      bytes = await image
        .rotate()
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      throw invalidImage();
    }
    const storage = getStorageProvider();
    const key = `${prefix}/${randomUUID()}.webp`;
    const url = await storage.uploadPublic(bytes, key, "image/webp", {
      cacheControl: "public, max-age=86400",
    });
    let saved: unknown;
    try {
      saved = await save(url);
    } catch (error) {
      try {
        await storage.delete(key);
      } catch (error) {
        log.warn({ err: error, key }, "Failed to delete unsaved networking image");
      }
      throw error;
    }
    const old = ownedStorageKey(previousUrl, prefix);
    if (old) {
      try {
        await storage.delete(old);
      } catch (error) {
        log.warn({ err: error, key: old }, "Failed to delete replaced networking image");
      }
    }
    return { url, resource: saved };
  }
}

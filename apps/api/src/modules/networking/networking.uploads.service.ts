import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  extractStorageKeyFromUrl,
  getStorageProvider,
} from "@app/integrations";
import { createLogger } from "@app/shared";
import type { FastifyRequest } from "fastify";
const log = createLogger({ name: "networking:uploads" });
export type NetworkingMultipartRequest = FastifyRequest & {
  file(options?: {
    limits: { fileSize: number; files: number };
  }): Promise<{ toBuffer(): Promise<Buffer> } | undefined>;
};
@Injectable()
export class NetworkingUploadsService {
  async deletePhoto(photoUrl: string | null | undefined, profileId: string) {
    if (!photoUrl) return;
    try {
      const key = extractStorageKeyFromUrl(photoUrl);
      if (key) await getStorageProvider().delete(key);
    } catch (error) {
      const failure = error as {
        code?: string | number;
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        failure?.code === 404 ||
        failure?.code === "404" ||
        failure?.name === "NoSuchKey" ||
        failure?.$metadata?.httpStatusCode === 404
      ) return;
      log.warn({ err: error, profileId }, "Failed to delete withdrawn networking photo");
    }
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
    let bytes: Buffer;
    try {
      const image = sharp(source, {
        limitInputPixels: 20_000_000,
        animated: false,
      });
      const metadata = await image.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
        throw new Error();
      bytes = await image
        .rotate()
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      throw new BadRequestException({ code: "NETWORKING_VALIDATION", message: "Use a valid PNG, JPEG or WebP image up to 5 MB and 20 megapixels" });
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
    const old = previousUrl ? extractStorageKeyFromUrl(previousUrl) : null;
    if (old?.startsWith(`${prefix}/`)) {
      try {
        await storage.delete(old);
      } catch (error) {
        log.warn({ err: error, key: old }, "Failed to delete replaced networking image");
      }
    }
    return { url, resource: saved };
  }
}

import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  extractStorageKeyFromUrl,
  getStorageProvider,
} from "@app/integrations";
import type { FastifyRequest } from "fastify";
export type NetworkingMultipartRequest = FastifyRequest & {
  file(options?: {
    limits: { fileSize: number; files: number };
  }): Promise<{ toBuffer(): Promise<Buffer> } | undefined>;
};
@Injectable()
export class NetworkingUploadsService {
  async image(
    req: NetworkingMultipartRequest,
    prefix: string,
    save: (url: string) => Promise<unknown>,
    previousUrl?: string | null,
  ) {
    const part = await req.file({
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    });
    if (!part) throw new BadRequestException("Choose an image to upload");
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
      throw new BadRequestException(
        "Use a valid PNG, JPEG or WebP image up to 5 MB and 20 megapixels",
      );
    }
    const storage = getStorageProvider();
    const key = `${prefix}/${randomUUID()}.webp`;
    const url = await storage.uploadPublic(bytes, key, "image/webp", {
      cacheControl: "public, max-age=31536000, immutable",
    });
    let saved: unknown;
    try {
      saved = await save(url);
    } catch (error) {
      try {
        await storage.delete(key);
      } catch {}
      throw error;
    }
    const old = previousUrl ? extractStorageKeyFromUrl(previousUrl) : null;
    if (old?.startsWith(`${prefix}/`)) {
      try {
        await storage.delete(old);
      } catch {}
    }
    return { url, resource: saved };
  }
}

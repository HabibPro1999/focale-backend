import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const storage = vi.hoisted(() => ({ uploadPublic: vi.fn(), delete: vi.fn() }));
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => storage,
  extractStorageKeyFromUrl: (url: string) => new URL(url).pathname.slice(1),
}));
import {
  NetworkingUploadsService,
  type NetworkingMultipartRequest,
} from "./networking.uploads.service";
const request = (buffer: Buffer) =>
  ({
    file: async () => ({ toBuffer: async () => buffer }),
  }) as NetworkingMultipartRequest;
const service = new NetworkingUploadsService();
beforeEach(() => {
  vi.clearAllMocks();
  storage.uploadPublic.mockResolvedValue("https://storage.example/new.webp");
  storage.delete.mockResolvedValue(undefined);
});
describe("networking image uploads", () => {
  it("decodes and sanitizes images before persisting a URL", async () => {
    const original = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "blue" },
    })
      .png()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const save = vi.fn().mockResolvedValue({ id: "profile" });
    const response = await service.image(
      request(original),
      "networking/event/profiles/profile",
      save,
    );
    const [bytes, key, mime] = storage.uploadPublic.mock.calls[0];
    expect(mime).toBe("image/webp");
    expect(key).toMatch(/^networking\/event\/profiles\/profile\/.*\.webp$/);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(8);
    expect(response.resource).toEqual({ id: "profile" });
  });
  it("rejects SVG and malformed data without a storage mutation", async () => {
    await expect(
      service.image(
        request(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
          ),
        ),
        "prefix",
        async () => null,
      ),
    ).rejects.toThrow("PNG, JPEG or WebP");
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });
  it("removes a newly uploaded object when persistence fails", async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(
      service.image(request(png), "networking/event/profiles/p", async () => {
        throw new Error("Write failed");
      }),
    ).rejects.toThrow("Write failed");
    expect(storage.delete).toHaveBeenCalledWith(
      storage.uploadPublic.mock.calls[0][1],
    );
  });
  it("never deletes a prior URL outside the participant-owned storage prefix", async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await service.image(
      request(png),
      "networking/event/profiles/p",
      async () => null,
      "https://storage.example/networking/other/profiles/p/photo.webp",
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

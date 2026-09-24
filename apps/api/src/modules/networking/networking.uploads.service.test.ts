import { crc32, deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
const storage = vi.hoisted(() => ({ uploadPublic: vi.fn(), delete: vi.fn() }));
// Real sharp, wrapped so tests can tell whether the service ever invoked it.
const sharpCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("sharp", async (original) => {
  const actual = (await original<{ default: (...args: unknown[]) => unknown }>()).default;
  return {
    default: (...args: unknown[]) => {
      sharpCalls.count++;
      return actual(...args);
    },
  };
});
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  getStorageProvider: () => storage,
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
    expect(storage.uploadPublic.mock.calls[0][3]).toEqual({ cacheControl: "public, max-age=86400" });
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

/** 8-bit grayscale PNG with a valid IHDR CRC; without `pixels` the IDAT is empty. */
function craftedPng(width: number, height: number, pixels = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const rows = pixels ? Buffer.alloc((width + 1) * height) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("networking image upload hardening", () => {
  const invalid = { response: { code: "NETWORKING_VALIDATION" } };

  it("rejects a PNG declaring 16384×16384 (NETWORKING_VALIDATION), no storage mutation", async () => {
    await expect(
      service.image(request(craftedPng(16384, 16384)), "networking/event/profiles/p", async () => null),
    ).rejects.toMatchObject(invalid);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("rejects a real image just over 20 megapixels", async () => {
    await expect(
      service.image(request(craftedPng(4473, 4473, true)), "networking/event/profiles/p", async () => null),
    ).rejects.toMatchObject(invalid);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')],
    ["GIF", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
    ["text", Buffer.from("hello")],
  ])("sniffs magic bytes and never hands %s to sharp", async (_label, bytes) => {
    sharpCalls.count = 0;
    await expect(
      service.image(request(bytes), "networking/event/profiles/p", async () => null),
    ).rejects.toMatchObject(invalid);
    expect(sharpCalls.count).toBe(0);
    expect(storage.uploadPublic).not.toHaveBeenCalled();
  });

  it("still accepts a small valid JPEG and WebP", async () => {
    for (const encode of ["jpeg", "webp"] as const) {
      const image = sharp({ create: { width: 3, height: 2, channels: 3, background: "green" } });
      const bytes = await image[encode]().toBuffer();
      await expect(
        service.image(request(bytes), "networking/event/profiles/p", async () => ({ ok: true })),
      ).resolves.toMatchObject({ resource: { ok: true } });
    }
    expect(storage.uploadPublic).toHaveBeenCalledTimes(2);
  });
});

describe("guarded networking photo deletion", () => {
  const own = "https://storage.example/networking/event/profiles/p/photo.webp";
  it("deletes only the participant's own photo and tolerates storage failures", async () => {
    await service.deletePhoto(own, "event", "p");
    expect(storage.delete).toHaveBeenCalledWith("networking/event/profiles/p/photo.webp");
    storage.delete.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(service.deletePhoto(own, "event", "p")).resolves.toBeUndefined();
  });
  it.each([
    "https://storage.example/forms/uploads/registrant-photo.webp",
    "https://storage.example/networking/event/profiles/other/photo.webp",
    "https://storage.example/networking/other-event/profiles/p/photo.webp",
    "https://storage.example/networking/event/profiles/p/../../../../abstracts/final.pdf",
    "https://storage.example/networking/event/branding/logo.webp",
    "abstracts/final.pdf",
    "",
    null,
  ])("never deletes an arbitrary or foreign object: %s", async (url) => {
    await service.deletePhoto(url, "event", "p");
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
it("removes the previous owned photo after replacement", async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await service.image(request(png), "networking/event/profiles/p", async () => null,
    "https://storage.example/networking/event/profiles/p/old.webp");
  expect(storage.delete).toHaveBeenCalledWith("networking/event/profiles/p/old.webp");
});

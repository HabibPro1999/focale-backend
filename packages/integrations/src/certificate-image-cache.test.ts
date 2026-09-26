import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDownload = vi.fn();
vi.mock("./storage/index", () => ({
  getStorageProvider: vi.fn(() => ({ download: mockDownload })),
}));

import {
  ByteLruCache,
  CERTIFICATE_IMAGE_CACHE_MAX_BYTES,
  certificateImageCache,
  loadCertificateImage,
} from "./certificate-image-cache";

const bytes = (n: number, fill = 1) => Buffer.alloc(n, fill);

describe("ByteLruCache (3.8)", () => {
  it("evicts the least recently used entries until the total bytes fit", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(40));
    cache.set("b", bytes(40));
    expect(cache.totalBytes).toBe(80);

    cache.set("c", bytes(40));

    expect(cache.has("a")).toBe(false);
    expect([cache.has("b"), cache.has("c")]).toEqual([true, true]);
    expect(cache.totalBytes).toBe(80);
  });

  it("counts bytes, not entries: one large entry evicts several small ones", () => {
    const cache = new ByteLruCache(100);
    for (const key of ["a", "b", "c", "d", "e"]) cache.set(key, bytes(20));
    expect(cache.size).toBe(5);

    cache.set("big", bytes(70));

    // 100 - 70 leaves room for one 20-byte entry: the most recent one.
    expect([...["a", "b", "c", "d", "e"].filter((k) => cache.has(k))]).toEqual(["e"]);
    expect(cache.totalBytes).toBe(90);
  });

  it("a read makes an entry the most recently used", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(40));
    cache.set("b", bytes(40));

    expect(cache.get("a")).toEqual(bytes(40));
    cache.set("c", bytes(40));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("replacing a key replaces its byte count", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(60));
    cache.set("a", bytes(10, 2));

    expect(cache.totalBytes).toBe(10);
    expect(cache.get("a")).toEqual(bytes(10, 2));
  });

  it("never stores a buffer larger than the cache, and drops the key's older entry", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(30));
    cache.set("b", bytes(30));

    expect(cache.set("a", bytes(101))).toBe(false);

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.totalBytes).toBe(30);
  });

  it("an entry of exactly the capacity fits and evicts everything else", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(1));
    expect(cache.set("full", bytes(100))).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(100);
  });

  it("delete and clear release the bytes", () => {
    const cache = new ByteLruCache(100);
    cache.set("a", bytes(30));
    cache.set("b", bytes(30));
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.totalBytes).toBe(30);
    cache.clear();
    expect([cache.size, cache.totalBytes]).toEqual([0, 0]);
  });

  it("refuses a non-positive capacity", () => {
    expect(() => new ByteLruCache(0)).toThrow(RangeError);
  });

  it("the process-wide certificate cache holds 64 MB", () => {
    expect(CERTIFICATE_IMAGE_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(certificateImageCache.maxBytes).toBe(CERTIFICATE_IMAGE_CACHE_MAX_BYTES);
  });
});

describe("loadCertificateImage (3.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    certificateImageCache.clear();
  });

  it("downloads a key once, then serves it from the process-wide cache", async () => {
    mockDownload.mockResolvedValue({ buffer: bytes(10, 7), contentType: "image/jpeg" });

    const first = await loadCertificateImage("evt/certificates/t-1-render.jpg");
    const second = await loadCertificateImage("evt/certificates/t-1-render.jpg");

    expect(first).toEqual(bytes(10, 7));
    expect(second).toBe(first);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(certificateImageCache.has("evt/certificates/t-1-render.jpg")).toBe(true);
  });

  it("parallel loads of one key on a cold cache share one download", async () => {
    let finish!: (file: { buffer: Buffer; contentType: string }) => void;
    mockDownload.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const loads = Array.from({ length: 10 }, () => loadCertificateImage("k"));
    finish({ buffer: bytes(5), contentType: "image/jpeg" });
    const results = await Promise.all(loads);

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it("does not cache a failed download; the next load retries", async () => {
    mockDownload
      .mockRejectedValueOnce(new Error("storage down"))
      .mockResolvedValueOnce({ buffer: bytes(3), contentType: "image/jpeg" });

    await expect(loadCertificateImage("k")).rejects.toThrow("storage down");
    expect(certificateImageCache.has("k")).toBe(false);

    await expect(loadCertificateImage("k")).resolves.toEqual(bytes(3));
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });
});

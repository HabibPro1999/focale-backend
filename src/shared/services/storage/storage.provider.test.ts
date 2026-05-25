import { beforeEach, describe, expect, it, vi } from "vitest";
import { firebaseStorageMock } from "../../../../tests/mocks/firebase.js";
import { FirebaseStorageProvider } from "./firebase-storage.provider.js";
import { R2StorageProvider } from "./r2-storage.provider.js";

const awsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  putObjectCommand: vi.fn(function PutObjectCommand(input: unknown) {
    return { input };
  }),
  getObjectCommand: vi.fn(function GetObjectCommand(input: unknown) {
    return { input };
  }),
  deleteObjectCommand: vi.fn(function DeleteObjectCommand(input: unknown) {
    return { input };
  }),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function S3Client() {
    return { send: awsMocks.send };
  }),
  PutObjectCommand: awsMocks.putObjectCommand,
  GetObjectCommand: awsMocks.getObjectCommand,
  DeleteObjectCommand: awsMocks.deleteObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://signed.example.com/file"),
}));

vi.mock("@config/app.config.js", () => ({
  config: {
    r2: {
      accountId: "account-id",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "bucket",
      publicUrl: "https://cdn.example.com/",
    },
  },
}));

describe("FirebaseStorageProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes public uploads public and returns a public URL", async () => {
    const file = {
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getSignedUrl: vi.fn().mockResolvedValue(["https://signed.example.com"]),
      exists: vi.fn().mockResolvedValue([true]),
      makePublic: vi.fn().mockResolvedValue(undefined),
      publicUrl: vi.fn().mockReturnValue("https://public.example.com/file"),
    };
    firebaseStorageMock.bucket.mockReturnValue({
      file: vi.fn(() => file),
    });

    const provider = new FirebaseStorageProvider();
    const result = await provider.uploadPublic(
      Buffer.from("file"),
      "public/file.webp",
      "image/webp",
    );

    expect(file.save).toHaveBeenCalledWith(
      Buffer.from("file"),
      expect.objectContaining({
        contentType: "image/webp",
        metadata: expect.objectContaining({
          cacheControl: "public, max-age=31536000",
        }),
      }),
    );
    expect(file.makePublic).toHaveBeenCalled();
    expect(result).toBe("https://public.example.com/file");
  });

  it("keeps private uploads private and returns the storage key", async () => {
    const file = {
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getSignedUrl: vi.fn().mockResolvedValue(["https://signed.example.com"]),
      exists: vi.fn().mockResolvedValue([true]),
      makePublic: vi.fn().mockResolvedValue(undefined),
      publicUrl: vi.fn(),
    };
    firebaseStorageMock.bucket.mockReturnValue({
      file: vi.fn(() => file),
    });

    const provider = new FirebaseStorageProvider();
    const result = await provider.uploadPrivate(
      Buffer.from("file"),
      "private/proof.webp",
      "image/webp",
      { contentDisposition: "attachment" },
    );

    expect(file.save).toHaveBeenCalledWith(
      Buffer.from("file"),
      expect.objectContaining({
        contentType: "image/webp",
        metadata: expect.objectContaining({
          cacheControl: "private, max-age=0",
          contentDisposition: "attachment",
        }),
      }),
    );
    expect(file.makePublic).not.toHaveBeenCalled();
    expect(result).toBe("private/proof.webp");
  });
});

describe("R2StorageProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    awsMocks.send.mockResolvedValue({});
  });

  it("returns public URLs only for public uploads", async () => {
    const provider = new R2StorageProvider();

    const result = await provider.uploadPublic(
      Buffer.from("file"),
      "public/file.webp",
      "image/webp",
    );

    expect(awsMocks.putObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "bucket",
        Key: "public/file.webp",
        CacheControl: "public, max-age=31536000",
      }),
    );
    expect(result).toBe("https://cdn.example.com/public/file.webp");
  });

  it("returns storage keys for private uploads", async () => {
    const provider = new R2StorageProvider();

    const result = await provider.uploadPrivate(
      Buffer.from("file"),
      "private/proof.webp",
      "image/webp",
    );

    expect(awsMocks.putObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "bucket",
        Key: "private/proof.webp",
        CacheControl: "private, max-age=0",
      }),
    );
    expect(result).toBe("private/proof.webp");
  });
});

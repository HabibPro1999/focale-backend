import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleStorageDeleteOutbox, isStorageObjectMissing } from "./storage-delete";
import { StorageObjectNotFoundError, type StorageProvider } from "./storage.provider";

const remove = vi.fn();
const provider = () => ({ delete: remove }) as unknown as StorageProvider;
const prefix = "networking/event/profiles/p";
const payload = (url: unknown, ownerPrefix: unknown = prefix) => ({ url, ownerPrefix, reason: "test" });
beforeEach(() => {
  remove.mockReset().mockResolvedValue(undefined);
});

describe("storage.delete outbox handler", () => {
  it("deletes an owned upload and reports it processed", async () => {
    await expect(handleStorageDeleteOutbox(payload(`https://cdn.test/${prefix}/photo.webp`), provider)).resolves.toBe("processed");
    expect(remove).toHaveBeenCalledWith(`${prefix}/photo.webp`);
  });

  it.each([
    [new StorageObjectNotFoundError("k")],
    [{ code: 404 }],
    [{ code: "404" }],
    [{ name: "NoSuchKey" }],
    [{ $metadata: { httpStatusCode: 404 } }],
  ])("counts an already-missing object as done: %o", async (error) => {
    remove.mockRejectedValue(error);
    await expect(handleStorageDeleteOutbox(payload(`${prefix}/photo.webp`), provider)).resolves.toBe("processed");
  });

  it("throws any other provider failure so the outbox retries with backoff", async () => {
    remove.mockRejectedValue(Object.assign(new Error("unavailable"), { $metadata: { httpStatusCode: 503 } }));
    await expect(handleStorageDeleteOutbox(payload(`${prefix}/photo.webp`), provider)).rejects.toThrow("unavailable");
  });

  it.each([
    ["a form-supplied upload", payload("https://cdn.test/forms/uploads/registrant.webp")],
    ["another participant's photo", payload("https://cdn.test/networking/event/profiles/other/photo.webp")],
    ["another event's photo", payload("https://cdn.test/networking/other/profiles/p/photo.webp")],
    ["a traversal", payload(`https://cdn.test/${prefix}/../../../../abstracts/final.pdf`)],
    ["a bare foreign key", payload("abstracts/final.pdf")],
    ["the prefix itself", payload(`https://cdn.test/${prefix}`)],
    ["a prefix outside the allowed roots", payload("https://cdn.test/abstracts/e/final.pdf", "abstracts/e")],
    ["an empty prefix", payload("https://cdn.test/networking/event/profiles/p/photo.webp", "")],
    ["a missing url", payload(undefined)],
    ["a malformed payload", null],
  ])("never deletes %s: skipped", async (_label, body) => {
    await expect(handleStorageDeleteOutbox(body, provider)).resolves.toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
  });
});

it("recognizes provider not-found shapes only", () => {
  expect(isStorageObjectMissing(new StorageObjectNotFoundError("k"))).toBe(true);
  expect(isStorageObjectMissing({ code: 403 })).toBe(false);
  expect(isStorageObjectMissing(null)).toBe(false);
});

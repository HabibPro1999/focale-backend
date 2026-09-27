import { expect, it, vi } from "vitest";
import { deleteOwnedNetworkingPhoto } from "./networking-photo";

it.each([{ code: 404 }, { code: "404" }, { name: "NoSuchKey" }, { $metadata: { httpStatusCode: 404 } }])("treats the existing storage-missing shape %j as already deleted", async (error) => {
  const storage = { delete: vi.fn().mockRejectedValue(error) };
  await expect(deleteOwnedNetworkingPhoto("networking/event/profiles/profile/photo.webp", "event", "profile", storage)).resolves.toBeUndefined();
  expect(storage.delete).toHaveBeenCalledExactlyOnceWith("networking/event/profiles/profile/photo.webp");
});
it("propagates other storage failures for the caller's original logger", async () => {
  const error = new Error("storage unavailable");
  await expect(deleteOwnedNetworkingPhoto("networking/event/profiles/profile/photo.webp", "event", "profile", { delete: vi.fn().mockRejectedValue(error) })).rejects.toBe(error);
});
it("deletes owned objects and skips foreign objects without accessing storage", async () => {
  const storage = { delete: vi.fn().mockResolvedValue(undefined) };
  expect(await deleteOwnedNetworkingPhoto("forms/event/photo.webp", "event", "profile", storage)).toBeUndefined();
  expect(storage.delete).not.toHaveBeenCalled();
  expect(await deleteOwnedNetworkingPhoto("networking/event/profiles/profile/photo.webp", "event", "profile", storage)).toBeUndefined();
});

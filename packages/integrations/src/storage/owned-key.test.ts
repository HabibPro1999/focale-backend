import { describe, expect, it } from "vitest";
import { ownedStorageKey } from "./index";

const prefix = "networking/event-1/profiles/profile-1";

describe("ownedStorageKey", () => {
  it.each([
    ["https://assets.example/networking/event-1/profiles/profile-1/a.webp", "networking/event-1/profiles/profile-1/a.webp"],
    ["https://storage.googleapis.com/bucket/networking/event-1/profiles/profile-1/b.webp", "networking/event-1/profiles/profile-1/b.webp"],
    ["networking/event-1/profiles/profile-1/c.webp", "networking/event-1/profiles/profile-1/c.webp"],
  ])("returns the key of an object under the owner prefix: %s", (url, key) => {
    expect(ownedStorageKey(url, prefix)).toBe(key);
  });

  it.each([
    null,
    undefined,
    "",
    "https://assets.example/networking/event-1/profiles/profile-2/a.webp",
    "https://assets.example/networking/event-1/profiles/profile-10/a.webp",
    "https://assets.example/networking/event-1/profiles/profile-1",
    "https://assets.example/networking/event-2/profiles/profile-1/a.webp",
    "https://assets.example/forms/uploads/registrant-photo.webp",
    "https://assets.example/networking/event-1/profiles/profile-1/../../../../abstracts/final.pdf",
    "https://assets.example/networking/event-1/profiles/profile-1/%2E%2E/x.webp",
    "https://assets.example/networking/event-1/profiles/profile-1//x.webp",
    "not a url://",
  ])("refuses anything outside the owner prefix: %s", (url) => {
    expect(ownedStorageKey(url, prefix)).toBeNull();
  });

  it("never treats an empty prefix as ownership of the whole bucket", () => {
    expect(ownedStorageKey("https://assets.example/anything.webp", "")).toBeNull();
  });
});

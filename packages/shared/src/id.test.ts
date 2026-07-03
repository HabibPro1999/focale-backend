import { describe, it, expect } from "vitest";
import { newId } from "./id";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("produces UUIDv7 format", () => {
    expect(newId()).toMatch(UUID_V7);
  });

  it("is time-ordered (later ids sort after earlier ones)", async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 3));
    const b = newId();
    expect(a < b).toBe(true);
  });

  it("is unique across a burst", () => {
    const set = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(set.size).toBe(1000);
  });
});

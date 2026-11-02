import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, getPrimaryLanguage } from "./i18n.schema";

describe("getPrimaryLanguage", () => {
  it("returns the first entry of the ordered languages list", () => {
    expect(getPrimaryLanguage(["en", "fr"])).toBe("en");
    expect(getPrimaryLanguage(["ar"])).toBe("ar");
  });

  it("defaults to fr when languages is absent or not a list", () => {
    expect(DEFAULT_LANGUAGE).toBe("fr");
    expect(getPrimaryLanguage(undefined)).toBe("fr");
    expect(getPrimaryLanguage(null)).toBe("fr");
    expect(getPrimaryLanguage("en")).toBe("fr");
    expect(getPrimaryLanguage([])).toBe("fr");
  });

  it("skips unsupported entries", () => {
    expect(getPrimaryLanguage(["de", 1, "ar", "en"])).toBe("ar");
    expect(getPrimaryLanguage(["de"])).toBe("fr");
  });
});

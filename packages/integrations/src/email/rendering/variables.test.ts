import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getRegistrationFormSchema: vi.fn(),
}));

import { getRegistrationFormSchema } from "@app/db";
import { BASE_VARIABLES, getAvailableVariables } from "./variables";

describe("BASE_VARIABLES", () => {
  it("covers the core categories", () => {
    const categories = new Set(BASE_VARIABLES.map((v) => v.category));
    for (const c of [
      "registration",
      "event",
      "payment",
      "access",
      "links",
      "bank",
      "sponsorship",
      "certificate",
      "abstract",
    ]) {
      expect(categories.has(c as never)).toBe(true);
    }
  });

  it("every entry has a non-empty example", () => {
    for (const v of BASE_VARIABLES) {
      expect(v.example && v.example.length > 0).toBe(true);
    }
  });

  // M7 gap: the ABSTRACT_COMMITTEE_INVITE templated path (committee service)
  // substitutes exactly reviewerName/eventName/loginLink — eventName already
  // existed under "event"; reviewerName/loginLink must be picker-visible too.
  it("lists the ABSTRACT_COMMITTEE_INVITE variables under the abstract category", () => {
    const byId = new Map(BASE_VARIABLES.map((v) => [v.id, v]));
    expect(byId.get("reviewerName")).toMatchObject({ category: "abstract" });
    expect(byId.get("loginLink")).toMatchObject({ category: "abstract" });
  });
});

describe("getAvailableVariables", () => {
  beforeEach(() => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue(null);
  });

  it("returns base-only when no registration form exists", async () => {
    const vars = await getAvailableVariables("evt-1");
    expect(vars).toHaveLength(BASE_VARIABLES.length);
  });

  it("appends form_<id> entries and skips non-data field types", async () => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue({
      steps: [
        {
          fields: [
            { id: "specialty", label: "Specialty", type: "text" },
            { id: "sec", label: "Section", type: "heading" },
            { id: "note", type: "paragraph" },
          ],
        },
      ],
    });
    const vars = await getAvailableVariables("evt-1");
    const formVars = vars.filter((v) => v.category === "form");
    expect(formVars).toHaveLength(1);
    expect(formVars[0].id).toBe("form_specialty");
    expect(formVars[0].label).toBe("Specialty");
    expect(formVars[0].example).toBe("Sample text");
  });

  it("uses the field id as the label when none is provided", async () => {
    vi.mocked(getRegistrationFormSchema).mockResolvedValue({
      steps: [{ fields: [{ id: "foo", type: "number" }] }],
    });
    const vars = await getAvailableVariables("evt-1");
    const formVar = vars.find((v) => v.id === "form_foo");
    expect(formVar?.label).toBe("foo");
    expect(formVar?.example).toBe("42");
  });
});

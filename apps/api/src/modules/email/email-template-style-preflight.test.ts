import { describe, expect, it } from "vitest";
import { preflightEmailTemplateContent } from "./email-template-style-preflight";

describe("preflightEmailTemplateContent", () => {
  it("removes hostile node styles, normalizes bare lengths, and preserves editor attrs", () => {
    const result = preflightEmailTemplateContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            textAlign: 'left"><mj-include path="/etc/passwd" />',
            fontSize: "18",
            lineHeight: '1.5"><mj-include path="/etc/passwd" />',
            customEditorAttr: "keep-me",
          },
          content: [{ type: "mention", attrs: { id: "firstName" } }],
        },
        { type: "paragraph", attrs: { lineHeight: 1.6 } },
      ],
    });

    expect(result.changes).toEqual([
      { path: "content.content[0]", attribute: "textAlign", action: "removed" },
      { path: "content.content[0]", attribute: "fontSize", action: "normalized" },
      { path: "content.content[0]", attribute: "lineHeight", action: "removed" },
      { path: "content.content[1]", attribute: "lineHeight", action: "normalized" },
    ]);
    expect(result.validationIssues).toEqual([]);
    expect(result.content?.content[0]?.attrs).toMatchObject({
      fontSize: "18px",
      customEditorAttr: "keep-me",
    });
    expect(result.content?.content[0]?.content?.[0]?.attrs).toMatchObject({
      id: "firstName",
    });
    expect(result.content?.content[1]?.attrs?.lineHeight).toBe("1.6");
  });

  it("leaves structurally invalid documents for manual review", () => {
    const result = preflightEmailTemplateContent({
      type: "not-a-doc",
      content: [],
    });

    expect(result.content).toBeNull();
    expect(result.changes).toEqual([]);
    expect(result.validationIssues.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import type { TiptapNode, TiptapMark } from "./email.types.js";
import type { TiptapDocument } from "./email.schema.js";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
  renderNode,
  renderInlineContent,
  renderInlineNode,
  applyMarks,
} from "./email-renderer.service.js";

// ============================================================================
// Helpers
// ============================================================================

function doc(...nodes: TiptapNode[]): TiptapDocument {
  return { type: "doc", content: nodes };
}

function paragraph(
  children: TiptapNode[] = [],
  attrs?: Record<string, unknown>,
): TiptapNode {
  return { type: "paragraph", content: children, ...(attrs ? { attrs } : {}) };
}

function text(value: string, marks?: TiptapMark[]): TiptapNode {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

function mention(id: string, label: string): TiptapNode {
  return { type: "mention", attrs: { id, label } };
}

function heading(level: number, children: TiptapNode[]): TiptapNode {
  return { type: "heading", attrs: { level }, content: children };
}

function bulletList(items: TiptapNode[][]): TiptapNode {
  return {
    type: "bulletList",
    content: items.map((children) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: children }],
    })),
  };
}

function orderedList(items: TiptapNode[][]): TiptapNode {
  return {
    type: "orderedList",
    content: items.map((children) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: children }],
    })),
  };
}

// ============================================================================
// renderTemplateToMjml
// ============================================================================

describe("renderTemplateToMjml", () => {
  it("wraps output in mjml structure with head and body", () => {
    const result = renderTemplateToMjml(doc(paragraph([text("Hello")])));
    expect(result).toContain("<mjml>");
    expect(result).toContain("<mj-head>");
    expect(result).toContain("<mj-body");
    expect(result).toContain("</mjml>");
  });

  describe("paragraph", () => {
    it("renders paragraph with text content", () => {
      const result = renderTemplateToMjml(
        doc(paragraph([text("Hello world")])),
      );
      expect(result).toContain("<mj-text");
      expect(result).toContain("Hello world");
    });

    it("renders empty paragraph as spacer", () => {
      const result = renderTemplateToMjml(doc(paragraph([])));
      expect(result).toContain("<mj-text>&nbsp;</mj-text>");
    });

    it("respects text alignment", () => {
      const result = renderTemplateToMjml(
        doc(paragraph([text("Centered")], { textAlign: "center" })),
      );
      expect(result).toContain('align="center"');
    });

    it("defaults invalid alignment to left", () => {
      const result = renderTemplateToMjml(
        doc(paragraph([text("Text")], { textAlign: "invalid-align" })),
      );
      expect(result).toContain('align="left"');
    });
  });

  describe("heading levels", () => {
    it.each([1, 2, 3, 4, 5, 6])(
      "renders heading h%i with bold font",
      (level) => {
        const result = renderTemplateToMjml(
          doc(heading(level, [text("Title")])),
        );
        expect(result).toContain('font-weight="bold"');
        expect(result).toContain("Title");
      },
    );

    it("renders h1 with 28px font size", () => {
      const result = renderTemplateToMjml(doc(heading(1, [text("H1")])));
      expect(result).toContain('font-size="28px"');
    });

    it("renders h6 with 14px font size", () => {
      const result = renderTemplateToMjml(doc(heading(6, [text("H6")])));
      expect(result).toContain('font-size="14px"');
    });
  });

  describe("lists", () => {
    it("renders bulletList with ul and li elements", () => {
      const result = renderTemplateToMjml(
        doc(bulletList([[text("Item 1")], [text("Item 2")]])),
      );
      expect(result).toContain("<ul");
      expect(result).toContain("<li>Item 1</li>");
      expect(result).toContain("<li>Item 2</li>");
    });

    it("renders orderedList with ol and li elements", () => {
      const result = renderTemplateToMjml(
        doc(orderedList([[text("First")], [text("Second")]])),
      );
      expect(result).toContain("<ol");
      expect(result).toContain("<li>First</li>");
      expect(result).toContain("<li>Second</li>");
    });
  });

  describe("blockquote", () => {
    it("renders blockquote with mj-section and border-left", () => {
      const node: TiptapNode = {
        type: "blockquote",
        content: [paragraph([text("Quoted text")])],
      };
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("border-left");
      expect(result).toContain("Quoted text");
    });
  });

  describe("horizontalRule", () => {
    it("renders as mj-divider", () => {
      const result = renderTemplateToMjml(doc({ type: "horizontalRule" }));
      expect(result).toContain("<mj-divider");
    });
  });

  describe("image", () => {
    it("renders image with src, alt, and width", () => {
      const node: TiptapNode = {
        type: "image",
        attrs: {
          src: "https://example.com/photo.jpg",
          alt: "Photo",
          width: "400",
        },
      };
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("<mj-image");
      expect(result).toContain('src="https://example.com/photo.jpg"');
      expect(result).toContain('alt="Photo"');
      expect(result).toContain('width="400"');
    });

    it("strips javascript: from image src (XSS prevention)", () => {
      const node: TiptapNode = {
        type: "image",
        attrs: { src: "javascript:alert(1)", alt: "" },
      };
      const result = renderTemplateToMjml(doc(node));
      // sanitizeUrl replaces javascript: with "#blocked", never leaks the original
      expect(result).not.toContain("javascript:");
    });
  });

  describe("link-type mention as button", () => {
    it("renders standalone registrationLink mention as mj-button", () => {
      const node = paragraph([
        mention("registrationLink", "Registration Link"),
      ]);
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("<mj-button");
      expect(result).toContain('href="{{registrationLink}}"');
      expect(result).toContain("View Registration");
    });

    it("renders standalone paymentLink mention as mj-button", () => {
      const node = paragraph([mention("paymentLink", "Payment Link")]);
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("<mj-button");
      expect(result).toContain('href="{{paymentLink}}"');
    });

    it("renders editRegistrationLink mention as mj-button", () => {
      const node = paragraph([mention("editRegistrationLink", "Edit")]);
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("<mj-button");
      expect(result).toContain('href="{{editRegistrationLink}}"');
    });

    it("renders non-link mention inline as {{variable}}", () => {
      const node = paragraph([
        text("Hello "),
        mention("firstName", "First Name"),
      ]);
      const result = renderTemplateToMjml(doc(node));
      expect(result).toContain("{{firstName}}");
      // Should not render a button with this variable as href
      expect(result).not.toContain('href="{{firstName}}"');
    });
  });
});

// ============================================================================
// compileMjmlToHtml (real MJML — no mock)
// ============================================================================

describe("compileMjmlToHtml", () => {
  const validMjml = `
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello World</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`.trim();

  it("compiles valid MJML to an HTML string", () => {
    const result = compileMjmlToHtml(validMjml);
    expect(result.html).toContain("<!doctype html");
    expect(result.html.toLowerCase()).toContain("hello world");
    expect(result.errors).toHaveLength(0);
  });

  it("returns html property as a non-empty string", () => {
    const result = compileMjmlToHtml(validMjml);
    expect(typeof result.html).toBe("string");
    expect(result.html.length).toBeGreaterThan(100);
  });

  it("throws on malformed MJML (unknown element)", () => {
    const badMjml = `
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-unknown-bad-tag>content</mj-unknown-bad-tag>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`.trim();

    // MJML strict validation throws — either MJML's own ValidationError
    // or our wrapped "MJML compilation failed:" message
    expect(() => compileMjmlToHtml(badMjml)).toThrow();
  });

  it("does not throw for template variable placeholders in content", () => {
    const mjmlWithVars = `
<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello {{firstName}}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`.trim();

    expect(() => compileMjmlToHtml(mjmlWithVars)).not.toThrow();
    const result = compileMjmlToHtml(mjmlWithVars);
    expect(result.html).toContain("{{firstName}}");
  });
});

// ============================================================================
// renderInlineNode / applyMarks
// ============================================================================

describe("renderInlineNode", () => {
  it("renders plain text node", () => {
    expect(renderInlineNode(text("Hello"))).toBe("Hello");
  });

  it("renders mention as {{variableId}}", () => {
    expect(renderInlineNode(mention("firstName", "First Name"))).toBe(
      "{{firstName}}",
    );
  });

  it("renders link-type mention inline as anchor tag", () => {
    const result = renderInlineNode(
      mention("registrationLink", "Registration"),
    );
    expect(result).toContain("<a");
    expect(result).toContain('href="{{registrationLink}}"');
  });

  it("renders hardBreak as <br />", () => {
    expect(renderInlineNode({ type: "hardBreak" })).toBe("<br />");
  });

  describe("marks — bold", () => {
    it("wraps text in <strong>", () => {
      const result = renderInlineNode(text("Bold text", [{ type: "bold" }]));
      expect(result).toBe("<strong>Bold text</strong>");
    });
  });

  describe("marks — italic", () => {
    it("wraps text in <em>", () => {
      const result = renderInlineNode(
        text("Italic text", [{ type: "italic" }]),
      );
      expect(result).toBe("<em>Italic text</em>");
    });
  });

  describe("marks — underline", () => {
    it("wraps text in <u>", () => {
      const result = renderInlineNode(
        text("Underline", [{ type: "underline" }]),
      );
      expect(result).toBe("<u>Underline</u>");
    });
  });

  describe("marks — strike", () => {
    it("wraps text in <s>", () => {
      const result = renderInlineNode(
        text("Strikethrough", [{ type: "strike" }]),
      );
      expect(result).toBe("<s>Strikethrough</s>");
    });
  });

  describe("marks — code", () => {
    it("wraps text in <code> with inline styles", () => {
      const result = renderInlineNode(text("code()", [{ type: "code" }]));
      expect(result).toContain("<code");
      expect(result).toContain("code()");
      expect(result).toContain("font-family: monospace");
    });
  });

  describe("marks — link", () => {
    it("wraps text in <a> with href", () => {
      const result = renderInlineNode(
        text("Click here", [
          { type: "link", attrs: { href: "https://example.com" } },
        ]),
      );
      expect(result).toContain("<a");
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain("Click here");
    });

    it("strips javascript: href (XSS via link)", () => {
      const result = renderInlineNode(
        text("evil", [
          { type: "link", attrs: { href: "javascript:alert(1)" } },
        ]),
      );
      expect(result).not.toContain("javascript:");
    });
  });

  describe("marks — textStyle CSS validation", () => {
    it("applies valid hex color", () => {
      const result = renderInlineNode(
        text("Colored", [{ type: "textStyle", attrs: { color: "#FF0000" } }]),
      );
      expect(result).toContain("color: #FF0000");
    });

    it("applies valid rgb color", () => {
      const result = renderInlineNode(
        text("RGB", [
          { type: "textStyle", attrs: { color: "rgb(255, 0, 0)" } },
        ]),
      );
      expect(result).toContain("color: rgb(255, 0, 0)");
    });

    it("applies valid named color", () => {
      const result = renderInlineNode(
        text("Named", [{ type: "textStyle", attrs: { color: "red" } }]),
      );
      expect(result).toContain("color: red");
    });

    it("strips XSS expression() from color", () => {
      const result = renderInlineNode(
        text("XSS", [
          {
            type: "textStyle",
            attrs: { color: "expression(alert(1))" },
          },
        ]),
      );
      expect(result).not.toContain("expression");
      expect(result).not.toContain("color:");
    });

    it("strips url(javascript:) from color", () => {
      const result = renderInlineNode(
        text("XSS", [
          {
            type: "textStyle",
            attrs: { color: "url(javascript:alert(1))" },
          },
        ]),
      );
      expect(result).not.toContain("javascript:");
      expect(result).not.toContain("color:");
    });

    it("strips data: URI from color value", () => {
      const result = renderInlineNode(
        text("XSS", [
          {
            type: "textStyle",
            attrs: { color: "url(data:text/html,<script>alert(1)</script>)" },
          },
        ]),
      );
      expect(result).not.toContain("data:");
    });

    it("applies valid font size", () => {
      const result = renderInlineNode(
        text("Big", [{ type: "textStyle", attrs: { fontSize: "18px" } }]),
      );
      expect(result).toContain("font-size: 18px");
    });

    it("strips invalid font size (XSS attempt)", () => {
      const result = renderInlineNode(
        text("XSS", [
          {
            type: "textStyle",
            attrs: { fontSize: "expression(alert(1))" },
          },
        ]),
      );
      expect(result).not.toContain("font-size");
      expect(result).not.toContain("expression");
    });

    it("applies valid font family", () => {
      const result = renderInlineNode(
        text("Font", [
          {
            type: "textStyle",
            attrs: { fontFamily: "Arial, sans-serif" },
          },
        ]),
      );
      expect(result).toContain("font-family: Arial, sans-serif");
    });
  });
});

// ============================================================================
// applyMarks
// ============================================================================

describe("applyMarks", () => {
  it("applies multiple marks in sequence", () => {
    const result = applyMarks("text", [{ type: "bold" }, { type: "italic" }]);
    expect(result).toContain("<em>");
    expect(result).toContain("<strong>");
  });

  it("returns unchanged text for unknown mark type", () => {
    const result = applyMarks("text", [{ type: "unknown-mark" }]);
    expect(result).toBe("text");
  });
});

// ============================================================================
// renderInlineContent
// ============================================================================

describe("renderInlineContent", () => {
  it("concatenates multiple inline nodes", () => {
    const result = renderInlineContent([text("Hello "), text("world")]);
    expect(result).toBe("Hello world");
  });

  it("returns empty string for empty array", () => {
    expect(renderInlineContent([])).toBe("");
  });
});

// ============================================================================
// renderNode
// ============================================================================

describe("renderNode", () => {
  it("renders horizontalRule as mj-divider", () => {
    const result = renderNode({ type: "horizontalRule" });
    expect(result).toContain("<mj-divider");
  });

  it("renders hardBreak as <br />", () => {
    const result = renderNode({ type: "hardBreak" });
    expect(result).toBe("<br />");
  });

  it("renders unknown node type by recursing into known children", () => {
    // Unknown wrapper containing a paragraph — paragraph is rendered
    const node: TiptapNode = {
      type: "custom-wrapper",
      content: [paragraph([text("inner")])],
    };
    const result = renderNode(node);
    expect(result).toContain("<mj-text");
    expect(result).toContain("inner");
  });

  it("returns empty string for unknown node with no content", () => {
    const result = renderNode({ type: "unknown-type" });
    expect(result).toBe("");
  });
});

// ============================================================================
// extractPlainText
// ============================================================================

describe("extractPlainText", () => {
  it("extracts text from paragraphs", () => {
    const result = extractPlainText(doc(paragraph([text("Hello world")])));
    expect(result).toContain("Hello world");
  });

  it("extracts text from multiple paragraphs separated by newlines", () => {
    const result = extractPlainText(
      doc(paragraph([text("First")]), paragraph([text("Second")])),
    );
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });

  it("extracts heading text without special prefix", () => {
    const result = extractPlainText(doc(heading(1, [text("My Heading")])));
    expect(result).toContain("My Heading");
  });

  it("extracts bullet list items with '- ' prefix", () => {
    const result = extractPlainText(
      doc(bulletList([[text("Item A")], [text("Item B")]])),
    );
    expect(result).toContain("- Item A");
    expect(result).toContain("- Item B");
  });

  it("extracts ordered list items with '1. ' prefix", () => {
    const result = extractPlainText(
      doc(orderedList([[text("First")], [text("Second")]])),
    );
    expect(result).toContain("1. First");
    expect(result).toContain("1. Second");
  });

  it("renders mention nodes as {{variableName}}", () => {
    const result = extractPlainText(
      doc(paragraph([text("Hello "), mention("firstName", "First Name")])),
    );
    expect(result).toContain("{{firstName}}");
  });

  it("renders horizontalRule as separator", () => {
    const result = extractPlainText(doc({ type: "horizontalRule" }));
    expect(result).toContain("---");
  });

  it("trims leading and trailing whitespace", () => {
    const result = extractPlainText(doc(paragraph([text("  content  ")])));
    // extractPlainText trims at the outer level
    expect(result.startsWith(" ")).toBe(false);
  });
});

// ============================================================================
// sanitizeUrl integration (tested transitively via image and link)
// ============================================================================

describe("sanitizeUrl integration", () => {
  it("allows normal https URL in image", () => {
    const node: TiptapNode = {
      type: "image",
      attrs: { src: "https://cdn.example.com/img.png", alt: "" },
    };
    const result = renderNode(node);
    expect(result).toContain("https://cdn.example.com/img.png");
  });

  it("strips javascript: URL from image src (replaced with #blocked)", () => {
    const node: TiptapNode = {
      type: "image",
      attrs: { src: "javascript:alert(1)", alt: "" },
    };
    const result = renderNode(node);
    // sanitizeUrl replaces javascript: with "#blocked", never leaks the original
    expect(result).not.toContain("javascript:");
  });

  it("allows http URL in image", () => {
    const node: TiptapNode = {
      type: "image",
      attrs: { src: "http://example.com/img.jpg", alt: "test" },
    };
    const result = renderNode(node);
    expect(result).toContain("<mj-image");
  });
});

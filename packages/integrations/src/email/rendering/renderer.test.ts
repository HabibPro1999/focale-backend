import { describe, expect, it } from "vitest";
import {
  renderTemplateToMjml,
  compileMjmlToHtml,
  extractPlainText,
} from "./renderer";
import type { TiptapDocument } from "@app/contracts";

const doc = (content: unknown[]): TiptapDocument =>
  ({ type: "doc", content }) as TiptapDocument;

describe("renderTemplateToMjml", () => {
  it("wraps content in the MJML skeleton with the organizer header + footer", () => {
    const mjml = renderTemplateToMjml(
      doc([{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }]),
    );
    expect(mjml).toContain("{{organizerName}}");
    expect(mjml).toContain("Powered by Focale Agency");
    expect(mjml).toContain("Hello");
  });

  it("escapes inline text (XSS)", () => {
    const mjml = renderTemplateToMjml(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "<b>x</b>" }] },
      ]),
    );
    expect(mjml).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("renders a standalone link-variable paragraph as an mj-button with a French label", () => {
    const mjml = renderTemplateToMjml(
      doc([
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "paymentLink" } }],
        },
      ]),
    );
    expect(mjml).toContain('mj-button href="{{paymentLink}}"');
    expect(mjml).toContain("Envoyer le justificatif de paiement");
  });

  it("renders a plain mention as a {{placeholder}}", () => {
    const mjml = renderTemplateToMjml(
      doc([
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "firstName" } }],
        },
      ]),
    );
    expect(mjml).toContain("{{firstName}}");
  });

  it("renders an empty paragraph as a spacer", () => {
    const mjml = renderTemplateToMjml(doc([{ type: "paragraph" }]));
    expect(mjml).toContain("<mj-text>&nbsp;</mj-text>");
  });
});

describe("compileMjmlToHtml", () => {
  it("compiles valid MJML (with unresolved {{vars}}) to HTML without throwing", () => {
    const mjml = renderTemplateToMjml(
      doc([{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }]),
    );
    const { html } = compileMjmlToHtml(mjml);
    expect(html).toContain("<html");
    expect(html).toContain("Hi");
  });

  it("throws on genuinely invalid MJML (surfaces as an unhandled 500)", () => {
    // Strict-mode mjml2html throws a ValidationError for unregistered elements.
    expect(() => compileMjmlToHtml("<mjml><mj-not-real /></mjml>")).toThrow();
  });
});

describe("extractPlainText", () => {
  it("joins text, keeps mentions as placeholders, and trims", () => {
    const text = extractPlainText(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: "firstName" } }] },
        { type: "paragraph", content: [{ type: "text", text: "Bye" }] },
      ]),
    );
    // Each block node appends "\n"; the top-level join adds another between them.
    expect(text).toBe("Hi {{firstName}}\n\nBye");
  });
});

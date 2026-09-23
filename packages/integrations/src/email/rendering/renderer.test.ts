import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("drops hostile style attrs before they can inject an MJML include", () => {
    const mjml = renderTemplateToMjml(
      doc([
        {
          type: "paragraph",
          attrs: {
            textAlign: 'left"><mj-include path="/tmp/canary" />',
            fontSize: '18px"><mj-include path="/tmp/canary" />',
            lineHeight: '1.5"><mj-include path="/tmp/canary" />',
          },
          content: [{ type: "text", text: "Safe paragraph" }],
        },
        {
          type: "heading",
          attrs: { textAlign: 'center"><mj-include path="/tmp/canary" />' },
          content: [{ type: "text", text: "Safe heading" }],
        },
        {
          type: "paragraph",
          attrs: { textAlign: 'right"><mj-include path="/tmp/canary" />' },
          content: [{ type: "mention", attrs: { id: "paymentLink" } }],
        },
      ]),
    );

    expect(mjml).not.toContain("<mj-include");
    expect(mjml).toContain('<mj-text align="left">Safe paragraph</mj-text>');
    expect(mjml).toContain('<mj-button href="{{paymentLink}}" align="left">');
  });

  it("normalizes bare font sizes while preserving unitless line height", () => {
    const mjml = renderTemplateToMjml(
      doc([
        {
          type: "paragraph",
          attrs: { fontSize: 16, lineHeight: 1.6 },
          content: [{ type: "text", text: "Readable spacing" }],
        },
      ]),
    );

    expect(mjml).toContain(
      '<mj-text align="left" font-size="16px" line-height="1.6">Readable spacing</mj-text>',
    );
  });

  it("normalizes image widths and falls back when a width is not an MJML pixel value", () => {
    const mjml = renderTemplateToMjml(
      doc([
        {
          type: "image",
          attrs: { src: "https://assets.example/image.png", width: 320 },
        },
        {
          type: "image",
          attrs: {
            src: "https://assets.example/injected.png",
            width: '600"><mj-include path="/tmp/canary" />',
          },
        },
      ]),
    );

    expect(mjml).toContain('width="320px"');
    expect(mjml).toContain('width="600px"');
    expect(mjml).not.toContain("<mj-include");
    expect(() => compileMjmlToHtml(mjml)).not.toThrow();
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

  it("does not read or include a temporary canary file", () => {
    const directory = mkdtempSync(join(tmpdir(), "mjml-include-canary-"));
    const canary = join(directory, "canary.mjml");
    const marker = "MJML_INCLUDE_CANARY_SHOULD_NOT_APPEAR";
    writeFileSync(
      canary,
      `<mjml><mj-body><mj-section><mj-column><mj-text>${marker}</mj-text></mj-column></mj-section></mj-body></mjml>`,
    );

    try {
      const { html } = compileMjmlToHtml(
        `<mjml><mj-body><mj-include path="${canary}" /></mj-body></mjml>`,
      );
      expect(html).not.toContain(marker);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

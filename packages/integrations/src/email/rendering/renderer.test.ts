import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FOCALE_MARK_URL,
  renderEmailLayout,
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
    expect(mjml).toContain("{{eventName}}");
    expect(mjml).toContain("{{eventDateRange}}");
    expect(mjml).toContain("Propulsé par");
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

  it("normalizes image widths and falls back when a width is not an MJML pixel value", async () => {
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
    await expect(Promise.resolve(compileMjmlToHtml(mjml))).resolves.toMatchObject({
      html: expect.stringContaining("<html"),
    });
  });
});

describe("renderEmailLayout (3.6b)", () => {
  it("is the layout renderTemplateToMjml uses", () => {
    const body = "<mj-text>Hello</mj-text>";
    expect(renderEmailLayout(body)).toBe(
      renderTemplateToMjml(doc([{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }])).replace(
        /<mj-text[^>]*>Hello<\/mj-text>/,
        body,
      ),
    );
  });

  it("takes a fixed header for emails without template variables", async () => {
    const mjml = renderEmailLayout('<mj-button href="https://x.test/a?b=1&amp;c=2">Go</mj-button>', {
      header: "Congr&#232;s &amp; Co",
    });
    expect(mjml).not.toContain("{{organizerName}}");
    const { html } = await compileMjmlToHtml(mjml);
    expect(html).toContain("Congr&#232;s &amp; Co");
    expect(html).toContain("Propulsé par");
    expect(html).toContain('href="https://x.test/a?b=1&amp;c=2"');
    // A fixed header has no "{{eventName}} · {{eventDateRange}}" line.
    expect(html).not.toContain("{{eventName}}");
    expect(html).not.toContain("{{eventDateRange}}");
  });
});

describe("Focale layout", () => {
  const sample = doc([
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Bonjour" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Voir : " },
        { type: "mention", attrs: { id: "registrationLink" } },
        { type: "text", text: " ou ", marks: [{ type: "link", attrs: { href: "https://x.test" } }] },
      ],
    },
    { type: "paragraph", content: [{ type: "mention", attrs: { id: "paymentLink" } }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Un" }] }] }] },
    { type: "horizontalRule" },
  ]);

  it("has no indigo left, in the MJML or the compiled HTML", async () => {
    const mjml = renderTemplateToMjml(sample);
    const { html } = await compileMjmlToHtml(mjml);
    for (const output of [mjml, html]) {
      expect(output.toLowerCase()).not.toContain("#4f46e5");
      expect(output.toLowerCase()).not.toContain("#e0e7ff");
      expect(output).not.toContain(".variable");
    }
  });

  it("paints the paper, the card, the amber rule and the ink header", () => {
    const mjml = renderTemplateToMjml(sample);
    expect(mjml).toContain('<mj-body background-color="#f9fafb">');
    expect(mjml).toContain('background-color="#ffffff" border="1px solid #e3e5ea" border-radius="6px"');
    expect(mjml).toContain('<mj-divider border-color="#d49311" border-width="3px"');
    expect(mjml).toMatch(/font-size="19px" font-weight="bold"[^>]*color="#1a1e25">\s*\{\{organizerName\}\}/);
    expect(mjml).toContain('color="#636978">&#8296;{{eventName}}&#8297; · &#8296;{{eventDateRange}}&#8297;</mj-text>');
    expect(mjml).toContain('<mj-text font-size="14px" line-height="1.6" color="#2b2f38" />');
  });

  it("styles buttons amber with ink bold text, and links dark amber and underlined", async () => {
    const mjml = renderTemplateToMjml(sample);
    expect(mjml).toContain(
      '<mj-button background-color="#d49311" color="#1a1e25" font-weight="bold" border-radius="6px"',
    );
    expect(mjml).toContain(
      '<a href="{{registrationLink}}" target="_blank" style="color: #8a6314; text-decoration: underline;">',
    );
    expect(mjml).toContain(
      '<a href="https://x.test" target="_blank" style="color: #8a6314; text-decoration: underline;">',
    );
    const { html } = await compileMjmlToHtml(mjml);
    expect(html).toMatch(/background:#d49311/);
    expect(html).toMatch(/color:#1a1e25/);
  });

  it("signs with the hosted Focale mark in the template's language", async () => {
    for (const [language, words] of [
      ["fr", "Propulsé par"],
      ["en", "Powered by"],
      ["ar", "بدعم من"],
    ] as const) {
      const { html } = await compileMjmlToHtml(renderTemplateToMjml(sample, { language }));
      expect(html).toContain(words);
      expect(html).toContain(`<img src="${FOCALE_MARK_URL}" width="16" height="16"`);
      expect(html).toContain("<b style=\"color: #1a1e25;\">Focale</b>");
      expect(html).not.toContain("Focale Agency");
    }
  });

  it("is a fixed light email", () => {
    const mjml = renderTemplateToMjml(sample);
    expect(mjml).toContain('<meta name="color-scheme" content="light">');
    expect(mjml).not.toContain("light dark");
  });

  it.each([
    ["fr", "Voir l'inscription", "Envoyer le justificatif de paiement", "Modifier l'inscription"],
    ["en", "View registration", "Send proof of payment", "Edit registration"],
    ["ar", "عرض التسجيل", "إرسال إثبات الدفع", "تعديل التسجيل"],
  ] as const)("labels link buttons and inline links in %s", (language, view, pay, edit) => {
    const mjml = renderTemplateToMjml(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "x " }, { type: "mention", attrs: { id: "registrationLink" } }] },
        { type: "paragraph", content: [{ type: "mention", attrs: { id: "paymentLink" } }] },
        { type: "paragraph", content: [{ type: "mention", attrs: { id: "editRegistrationLink" } }] },
      ]),
      { language },
    );
    expect(mjml).toContain(`style="color: #8a6314; text-decoration: underline;">${view}</a>`);
    expect(mjml).toContain(`>${pay}</mj-button>`);
    expect(mjml).toContain(`>${edit}</mj-button>`);
  });

  it("renders an Arabic template right to left, still passing strict MJML validation", async () => {
    const mjml = renderTemplateToMjml(sample, { language: "ar" });
    expect(mjml).toContain('<mjml lang="ar" dir="rtl">');
    expect(mjml).toContain('<mj-section direction="rtl" />');
    expect(mjml).toContain('<mj-text align="right">');
    expect(mjml).toContain("padding-right: 20px;");
    expect(
      renderTemplateToMjml(
        doc([{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] }]),
        { language: "ar" },
      ),
    ).toContain('border-right="4px solid #e3e5ea"');
    const { html } = await compileMjmlToHtml(mjml);
    expect(html).toContain('<html lang="ar" dir="rtl"');
    expect(html).not.toContain("direction:ltr");
  });

  it("keeps a left-to-right layout for fr and en, and an explicit alignment in ar", async () => {
    const mjml = renderTemplateToMjml(sample, { language: "en" });
    expect(mjml).toContain('<mjml lang="en" dir="ltr">');
    expect(mjml).not.toContain('direction="rtl"');
    const ar = renderTemplateToMjml(
      doc([{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "x" }] }]),
      { language: "ar" },
    );
    expect(ar).toContain('<mj-text align="center">x</mj-text>');
    await expect(compileMjmlToHtml(mjml)).resolves.toBeTruthy();
  });
});

describe("compileMjmlToHtml", () => {
  it("compiles valid MJML (with unresolved {{vars}}) to HTML without throwing", async () => {
    const mjml = renderTemplateToMjml(
      doc([{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }]),
    );
    const { html } = await compileMjmlToHtml(mjml);
    expect(html).toContain("<html");
    expect(html).toContain("Hi");
  });

  it("throws on genuinely invalid MJML (surfaces as an unhandled 500)", async () => {
    // Strict-mode mjml2html throws a ValidationError for unregistered elements.
    await expect(
      Promise.resolve().then(() =>
        compileMjmlToHtml("<mjml><mj-not-real /></mjml>"),
      ),
    ).rejects.toThrow();
  });

  it("does not read or include a temporary canary file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mjml-include-canary-"));
    const canary = join(directory, "canary.mjml");
    const marker = "MJML_INCLUDE_CANARY_SHOULD_NOT_APPEAR";
    writeFileSync(
      canary,
      `<mjml><mj-body><mj-section><mj-column><mj-text>${marker}</mj-text></mj-column></mj-section></mj-body></mjml>`,
    );

    try {
      const { html } = await compileMjmlToHtml(
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


describe("list markup characterization", () => {
  it.each([["bulletList", "ul"], ["orderedList", "ol"]] as const)("preserves %s items, marks and escaping", (type, tag) => {
    const mjml = renderTemplateToMjml(doc([{ type, content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "A & B", marks: [{ type: "bold" }] }] }] },
      { type: "listItem", content: [{ type: "text", text: "<second>" }] },
    ] }]));
    expect(mjml).toContain(`<${tag} style="margin: 0; padding-left: 20px;"><li><strong>A &amp; B</strong></li>\n<li>&lt;second&gt;</li></${tag}>`);
  });
});

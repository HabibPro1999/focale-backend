import { describe, expect, it, vi } from "vitest";
import { compileMjmlToHtml, renderTemplateToMjml } from "@app/integrations";
import {
  preflightEmailTemplateContent,
  runEmailTemplateStylePreflight,
} from "./email-template-style-preflight";

function suspiciousDocument() {
  return {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: {
          src: "https://assets.example/image.png",
          width: '600"><mj-include path="/tmp/canary" />',
        },
      },
      {
        type: "paragraph",
        content: [
          {
            type: "mention",
            attrs: { id: 'firstName"><mj-include path="/tmp/canary" />' },
          },
          {
            type: "text",
            text: "Link",
            marks: [
              {
                type: "link",
                attrs: {
                  href: "https://example.test/registration",
                  target: '_blank"><mj-include path="/tmp/canary" />',
                  custom: "data<mj-include",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

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

  it("finds suspicious attrs on images, mentions, and link marks without changing them", async () => {
    const document = suspiciousDocument();
    const result = preflightEmailTemplateContent(document);

    expect(result.content).not.toBeNull();
    expect(result.suspiciousAttributes).toEqual([
      "content.content[0].attrs.width",
      "content.content[1].content[0].attrs.id",
      "content.content[1].content[1].marks[0].attrs.target",
      "content.content[1].content[1].marks[0].attrs.custom",
    ]);
    expect(result.content?.content[0]?.attrs?.width).toBe(
      '600"><mj-include path="/tmp/canary" />',
    );
    expect(result.content?.content[1]?.content?.[0]?.attrs?.id).toBe(
      'firstName"><mj-include path="/tmp/canary" />',
    );
    expect(
      result.content?.content[1]?.content?.[1]?.marks?.[0]?.attrs,
    ).toMatchObject({
      href: "https://example.test/registration",
      target: '_blank"><mj-include path="/tmp/canary" />',
      custom: "data<mj-include",
    });
    await expect(
      Promise.resolve().then(() =>
        compileMjmlToHtml(renderTemplateToMjml(result.content!)),
      ),
    ).resolves.toMatchObject({ html: expect.stringContaining("<html") });
  });

  it("re-renders schema-valid templates with suspicious attrs in dry-run mode", async () => {
    const summary = await runEmailTemplateStylePreflight(
      [
        {
          id: "template1",
          name: "Welcome",
          content: suspiciousDocument(),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      { apply: false },
    );

    expect(summary.wouldUpdate).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.reports[0]?.status).toBe("would-update");
  });

  it("does not count a failed database write as an update", async () => {
    const update = vi.fn().mockRejectedValue(new Error("database write failed"));
    const summary = await runEmailTemplateStylePreflight(
      [
        {
          id: "template1",
          name: "Welcome",
          content: suspiciousDocument(),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      { apply: true, update },
    );

    expect(update).toHaveBeenCalledOnce();
    expect(summary.updated).toBe(0);
    expect(summary.manualReview).toBe(1);
    expect(summary.reports[0]?.status).toBe("manual-review");
  });

  it("does not count a concurrent edit as an update", async () => {
    const update = vi.fn().mockResolvedValue(null);
    const summary = await runEmailTemplateStylePreflight(
      [
        {
          id: "template1",
          name: "Welcome",
          content: suspiciousDocument(),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      { apply: true, update },
    );

    expect(summary.updated).toBe(0);
    expect(summary.conflicts).toBe(1);
    expect(summary.reports[0]?.status).toBe("conflict");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getEmailTemplateById: vi.fn(),
  findActiveTemplateForTrigger: vi.fn(),
  insertEmailTemplate: vi.fn(),
  updateEmailTemplate: vi.fn(),
  deleteEmailTemplateById: vi.fn(),
  listEmailTemplates: vi.fn(),
  listEventEmailLogs: vi.fn(),
}));

vi.mock("@app/integrations", () => ({
  renderTemplateToMjml: vi.fn(() => "MJML"),
  compileMjmlToHtml: vi.fn(() => ({ html: "HTML", errors: [] })),
  extractPlainText: vi.fn(() => "PLAIN"),
}));

import {
  getEmailTemplateById,
  findActiveTemplateForTrigger,
  insertEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplateById,
  listEmailTemplates,
  listEventEmailLogs,
} from "@app/db";
import { EmailTemplateService } from "./email-template.service";
import { AppException } from "../../core/app-exception";

const service = new EmailTemplateService();
const content = { type: "doc" as const, content: [] };

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tmpl-1",
    clientId: "client-1",
    eventId: "event-1",
    name: "Welcome",
    description: null,
    subject: "Hi",
    content,
    mjmlContent: "OLD_MJML",
    htmlContent: "OLD_HTML",
    plainContent: "OLD_PLAIN",
    category: "MANUAL",
    trigger: null,
    abstractTrigger: null,
    isDefault: false,
    isActive: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as never;
}

beforeEach(() => {
  // apps/api vitest config doesn't auto-clear; the @app/integrations factory
  // impls survive clearAllMocks (only call history is cleared).
  vi.clearAllMocks();
  vi.mocked(findActiveTemplateForTrigger).mockResolvedValue(null);
  vi.mocked(insertEmailTemplate).mockImplementation(
    async (values) => ({ ok: true, template: { id: "new", ...values } }) as never,
  );
  vi.mocked(updateEmailTemplate).mockImplementation(
    async (id, patch) => ({ id, ...patch }) as never,
  );
});

describe("create", () => {
  const baseArgs = {
    clientId: "client-1",
    eventId: "event-1",
    name: "Welcome",
    subject: "Hi",
    content,
  };

  it("creates a MANUAL template and precompiles content", async () => {
    const created = (await service.create({
      ...baseArgs,
      category: "MANUAL",
    })) as Record<string, unknown>;
    expect(created.mjmlContent).toBe("MJML");
    expect(created.htmlContent).toBe("HTML");
    expect(created.plainContent).toBe("PLAIN");
    expect(created.isActive).toBe(true); // default true
    expect(created.trigger).toBeNull();
  });

  it("creates an AUTOMATIC template with a registration trigger", async () => {
    const created = (await service.create({
      ...baseArgs,
      category: "AUTOMATIC",
      trigger: "REGISTRATION_CREATED",
    })) as Record<string, unknown>;
    expect(created.trigger).toBe("REGISTRATION_CREATED");
  });

  it("creates an AUTOMATIC template with an abstract trigger", async () => {
    const created = (await service.create({
      ...baseArgs,
      category: "AUTOMATIC",
      abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
    })) as Record<string, unknown>;
    expect(created.abstractTrigger).toBe("ABSTRACT_SUBMISSION_ACK");
  });

  it("respects an explicit isActive:false", async () => {
    const created = (await service.create({
      ...baseArgs,
      category: "MANUAL",
      isActive: false,
    })) as Record<string, unknown>;
    expect(created.isActive).toBe(false);
  });

  it("rejects an AUTOMATIC template with no trigger (400)", async () => {
    await expect(
      service.create({ ...baseArgs, category: "AUTOMATIC" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(insertEmailTemplate).not.toHaveBeenCalled();
  });

  it("rejects an AUTOMATIC template with BOTH triggers (400)", async () => {
    await expect(
      service.create({
        ...baseArgs,
        category: "AUTOMATIC",
        trigger: "REGISTRATION_CREATED",
        abstractTrigger: "ABSTRACT_SUBMISSION_ACK",
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("rejects a MANUAL template that carries a trigger (400)", async () => {
    await expect(
      service.create({
        ...baseArgs,
        category: "MANUAL",
        trigger: "REGISTRATION_CREATED",
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("409s when an active template already owns the trigger", async () => {
    vi.mocked(findActiveTemplateForTrigger).mockResolvedValue(templateRow());
    await expect(
      service.create({
        ...baseArgs,
        category: "AUTOMATIC",
        trigger: "REGISTRATION_CREATED",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows the trigger when the only active match is for a different event (scope check delegated to db)", async () => {
    vi.mocked(findActiveTemplateForTrigger).mockResolvedValue(null);
    await expect(
      service.create({
        ...baseArgs,
        category: "AUTOMATIC",
        trigger: "REGISTRATION_CREATED",
      }),
    ).resolves.toBeDefined();
  });

  it("maps a DB unique-index race to a 409", async () => {
    vi.mocked(insertEmailTemplate).mockResolvedValue({
      ok: false,
      conflictIndex: "email_template_registration_uniq",
    });
    await expect(
      service.create({ ...baseArgs, category: "MANUAL" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("update", () => {
  it("404s when the template is missing", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(null);
    await expect(service.update("x", { name: "n" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("updates name only without touching trigger fields", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(templateRow());
    await service.update("tmpl-1", { name: "New" });
    const patch = vi.mocked(updateEmailTemplate).mock.calls[0][1];
    expect(patch).toEqual({ name: "New" });
  });

  it("recompiles content when content is provided", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(templateRow());
    await service.update("tmpl-1", { content });
    const patch = vi.mocked(updateEmailTemplate).mock.calls[0][1];
    expect(patch).toMatchObject({
      mjmlContent: "MJML",
      htmlContent: "HTML",
      plainContent: "PLAIN",
    });
  });

  it("allows clearing description explicitly to null", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(templateRow());
    await service.update("tmpl-1", { description: null });
    const patch = vi.mocked(updateEmailTemplate).mock.calls[0][1];
    expect(patch).toEqual({ description: null });
  });

  it("clears both triggers when category flips to MANUAL", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(
      templateRow({ category: "AUTOMATIC", trigger: "REGISTRATION_CREATED" }),
    );
    await service.update("tmpl-1", { category: "MANUAL" });
    const patch = vi.mocked(updateEmailTemplate).mock.calls[0][1];
    expect(patch).toMatchObject({ trigger: null, abstractTrigger: null });
  });

  it("409s when switching to a trigger already owned by an active template", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(
      templateRow({ category: "MANUAL" }),
    );
    vi.mocked(findActiveTemplateForTrigger).mockResolvedValue(
      templateRow({ id: "other" }),
    );
    await expect(
      service.update("tmpl-1", {
        category: "AUTOMATIC",
        trigger: "PAYMENT_CONFIRMED",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("delete", () => {
  it("deletes an existing template", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(templateRow());
    await service.delete("tmpl-1");
    expect(deleteEmailTemplateById).toHaveBeenCalledWith("tmpl-1");
  });

  it("404s when missing", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(null);
    await expect(service.delete("x")).rejects.toMatchObject({ status: 404 });
    expect(deleteEmailTemplateById).not.toHaveBeenCalled();
  });
});

describe("duplicate", () => {
  it("copies compiled content and forces MANUAL/inactive with default name", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(
      templateRow({
        name: "Src",
        category: "AUTOMATIC",
        trigger: "REGISTRATION_CREATED",
      }),
    );
    const dup = (await service.duplicate("tmpl-1")) as Record<string, unknown>;
    expect(dup.name).toBe("Src (Copy)");
    expect(dup.category).toBe("MANUAL");
    expect(dup.trigger).toBeNull();
    expect(dup.isActive).toBe(false);
    expect(dup.mjmlContent).toBe("OLD_MJML"); // reused, not recompiled
  });

  it("uses a custom name when provided", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(templateRow());
    const dup = (await service.duplicate("tmpl-1", "Custom")) as Record<
      string,
      unknown
    >;
    expect(dup.name).toBe("Custom");
  });

  it("404s when the source is missing", async () => {
    vi.mocked(getEmailTemplateById).mockResolvedValue(null);
    await expect(service.duplicate("x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("list / listLogs", () => {
  it("returns a paginated template result", async () => {
    vi.mocked(listEmailTemplates).mockResolvedValue({
      data: [templateRow()],
      total: 1,
    });
    const res = await service.list("event-1", {
      page: 1,
      limit: 20,
    } as never);
    expect(res.meta.total).toBe(1);
    expect(res.data).toHaveLength(1);
  });

  it("returns a paginated logs result with limit-50 default plumbed through", async () => {
    vi.mocked(listEventEmailLogs).mockResolvedValue({ data: [], total: 0 });
    const res = await service.listLogs("event-1", {
      page: 1,
      limit: 50,
    } as never);
    expect(res.meta.limit).toBe(50);
    const args = vi.mocked(listEventEmailLogs).mock.calls[0][1];
    expect(args).toMatchObject({ skip: 0, limit: 50 });
  });
});

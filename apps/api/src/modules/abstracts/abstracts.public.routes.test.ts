import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { SubmitAbstractSchema } from "@app/contracts";
import { AbstractsPublicController } from "./abstracts.public.controller";
import { extractAbstractToken } from "./abstracts.token";
import { AppException } from "../../core/app-exception";
import type { AbstractsService } from "./abstracts.service";
import type { AbstractsFinalFileService } from "./abstracts.final-file.service";

const token = "a".repeat(64);

function fakeReq(query: Record<string, unknown> = {}, headers: Record<string, unknown> = {}) {
  return { query, headers, ip: "203.0.113.9" } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// Body validation parity (the schema the ZodValidationPipe enforces at the
// route boundary — a missing-fields submit is a 400 before the service runs).
// ---------------------------------------------------------------------------
describe("SubmitAbstractSchema validation", () => {
  it("rejects a body missing required fields", () => {
    expect(SubmitAbstractSchema.safeParse({ authorFirstName: "Ahmed" }).success).toBe(
      false,
    );
  });

  it("accepts a complete valid submission", () => {
    const parsed = SubmitAbstractSchema.safeParse({
      authorFirstName: "Ahmed",
      authorLastName: "Salah",
      authorAffiliation: "CHU Tunis",
      authorEmail: "ahmed@test.com",
      authorPhone: "+21612345678",
      coAuthors: [],
      requestedType: "ORAL_COMMUNICATION",
      themeIds: ["44444444-4444-4444-8444-444444444444"],
      content: { mode: "FREE_TEXT", title: "Test", body: "Body text" },
      additionalFieldsData: {},
      linkBaseUrl: "https://example.com",
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token extraction: header wins, malformed → 401 before the service.
// ---------------------------------------------------------------------------
describe("extractAbstractToken", () => {
  it("prefers the X-Abstract-Token header over the query param", () => {
    const header = "b".repeat(64);
    expect(extractAbstractToken(fakeReq({ token }, { "x-abstract-token": header }))).toBe(
      header,
    );
  });

  it("falls back to the ?token= query param", () => {
    expect(extractAbstractToken(fakeReq({ token }))).toBe(token);
  });

  it("throws 401 INVALID_TOKEN for a missing / malformed token", () => {
    for (const req of [fakeReq(), fakeReq({ token: "short" })]) {
      let caught: unknown;
      try {
        extractAbstractToken(req);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).getStatus()).toBe(401);
      expect((caught as AppException).getResponse()).toMatchObject({
        code: "AUTH_1002",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Controller delegation (routing/HTTP-code metadata verified by the framework;
// here we confirm each handler wires params/token/body to the right service).
// ---------------------------------------------------------------------------
describe("AbstractsPublicController", () => {
  const abstracts = {
    getPublicConfig: vi.fn().mockResolvedValue({ enabled: true }),
    submitAbstract: vi.fn().mockResolvedValue({ id: "x" }),
    getAbstractByToken: vi.fn().mockResolvedValue({ id: "x" }),
    editAbstract: vi.fn().mockResolvedValue({ id: "x" }),
  } as unknown as AbstractsService;
  const finalFile = {
    uploadAbstractFinalFile: vi.fn().mockResolvedValue({ id: "x" }),
  } as unknown as AbstractsFinalFileService;
  const controller = new AbstractsPublicController(abstracts, finalFile);

  it("GET config delegates to the service", async () => {
    await controller.getConfig({ slug: "s" });
    expect(abstracts.getPublicConfig).toHaveBeenCalledWith("s");
  });

  it("POST submit passes slug + body + ip", async () => {
    const body = { authorFirstName: "A" } as never;
    await controller.submit({ slug: "s" }, body, fakeReq());
    expect(abstracts.submitAbstract).toHaveBeenCalledWith("s", body, "203.0.113.9");
  });

  it("GET by id extracts the token then reads", async () => {
    await controller.getByToken({ id: "abs-1" }, { token }, fakeReq({ token }));
    expect(abstracts.getAbstractByToken).toHaveBeenCalledWith("abs-1", token);
  });

  it("PATCH edits with the extracted token", async () => {
    const body = { authorFirstName: "A" } as never;
    await controller.edit({ id: "abs-1" }, { token }, body, fakeReq({ token }));
    expect(abstracts.editAbstract).toHaveBeenCalledWith(
      "abs-1",
      token,
      body,
      "203.0.113.9",
    );
  });
});

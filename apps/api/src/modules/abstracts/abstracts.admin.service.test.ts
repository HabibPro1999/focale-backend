import { describe, it, expect, beforeEach, vi } from "vitest";

const getSignedUrl = vi.fn();

vi.mock("@app/db", () => ({
  listAdminAbstracts: vi.fn(),
  getAdminAbstractDetail: vi.fn(),
  finalizeAbstractTxn: vi.fn(),
  reopenAbstractTxn: vi.fn(),
  markAbstractPresentedTxn: vi.fn(),
}));
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => ({ getSignedUrl }),
}));

import {
  listAdminAbstracts,
  getAdminAbstractDetail,
  finalizeAbstractTxn,
  reopenAbstractTxn,
  markAbstractPresentedTxn,
} from "@app/db";
import { AbstractsAdminService } from "./abstracts.admin.service";
import { AppException } from "../../core/app-exception";

const mock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const eventId = "event-1";
const service = new AbstractsAdminService();

async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "abs-1",
    eventId,
    status: "SUBMITTED",
    code: null,
    codeNumber: null,
    content: { title: "  My Title  " },
    requestedType: "ORAL_COMMUNICATION",
    finalType: null,
    presentedAt: null,
    presentedBy: null,
    authorFirstName: "A",
    authorLastName: "B",
    authorAffiliation: "Aff",
    authorEmail: "a@b.com",
    authorPhone: "+1",
    averageScore: 12,
    reviewCount: 0,
    coAuthors: [],
    additionalFieldsData: {},
    registrationId: null,
    finalFileKey: null,
    finalFileKind: null,
    finalFileSize: null,
    finalFileUploadedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastEditedAt: null,
    themes: [{ id: "t1", label: "Theme A", sortOrder: 0 }],
    reviews: [],
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("listAdminAbstracts", () => {
  it("defaults to limit 50 / offset 0 and formats items", async () => {
    mock(listAdminAbstracts).mockResolvedValue({ items: [baseRow()], total: 1 });
    const result = await service.listAdminAbstracts(eventId, {});
    expect(listAdminAbstracts).toHaveBeenCalledWith(
      eventId,
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
    expect(result).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(result.items[0]).toMatchObject({
      title: "My Title",
      averageScore: null, // reviewCount 0 → suppressed
      themeLabels: ["Theme A"],
      themeIds: ["t1"],
      scoreSpread: { min: null, max: null, spread: null },
    });
  });

  it("computes score spread and exposes averageScore once reviews exist", async () => {
    const reviews = [
      {
        id: "r1",
        reviewerId: "u1",
        score: 8,
        comment: null,
        scoredAt: new Date(),
        active: true,
        reviewer: { id: "u1", name: "Rev One", email: "r1@x.com" },
      },
      {
        id: "r2",
        reviewerId: "u2",
        score: 16,
        comment: "ok",
        scoredAt: new Date(),
        active: true,
        reviewer: { id: "u2", name: null, email: "r2@x.com" },
      },
    ];
    mock(listAdminAbstracts).mockResolvedValue({
      items: [baseRow({ reviewCount: 2, averageScore: 12, reviews })],
      total: 1,
    });
    const result = await service.listAdminAbstracts(eventId, { limit: 10, offset: 5 });
    expect(listAdminAbstracts).toHaveBeenCalledWith(
      eventId,
      expect.objectContaining({ limit: 10, offset: 5 }),
    );
    expect(result.items[0].averageScore).toBe(12);
    expect(result.items[0].scoreSpread).toEqual({ min: 8, max: 16, spread: 8 });
    expect(result.items[0].reviews[0]).toMatchObject({
      reviewerName: "Rev One",
      score: 8,
    });
  });
});

describe("getAdminAbstract", () => {
  it("404s when the abstract is missing / event mismatch", async () => {
    mock(getAdminAbstractDetail).mockResolvedValue(null);
    await expect(service.getAdminAbstract(eventId, "abs-1")).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it("includes revisions + a signed final-file URL when a file is present", async () => {
    getSignedUrl.mockResolvedValue("https://signed/url");
    mock(getAdminAbstractDetail).mockResolvedValue({
      ...baseRow({ finalFileKey: "k/final.pdf", finalFileKind: "PDF" }),
      revisions: [
        {
          id: "rev-1",
          revisionNo: 2,
          snapshot: {},
          editedBy: "PUBLIC",
          editedIpAddress: "1.2.3.4",
          content: {},
          coAuthors: [],
          additionalFieldsData: {},
          createdAt: new Date(),
        },
      ],
    });

    const result = await service.getAdminAbstract(eventId, "abs-1");
    expect(getSignedUrl).toHaveBeenCalledWith("k/final.pdf", 3600);
    expect(result.finalFile).toMatchObject({
      key: "k/final.pdf",
      downloadUrl: "https://signed/url",
    });
    expect(result.revisions[0]).toMatchObject({ revisionNo: 2, editedBy: "PUBLIC" });
    expect(result).toHaveProperty("content");
  });

  it("skips the signed URL when no final file", async () => {
    mock(getAdminAbstractDetail).mockResolvedValue({ ...baseRow(), revisions: [] });
    const result = await service.getAdminAbstract(eventId, "abs-1");
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(result.finalFile.downloadUrl).toBeNull();
  });
});

describe("finalizeAbstract", () => {
  it("commits then returns a fresh post-commit read", async () => {
    mock(finalizeAbstractTxn).mockResolvedValue({ ok: true });
    mock(getAdminAbstractDetail).mockResolvedValue({
      ...baseRow({ status: "ACCEPTED", code: "OC1-01", finalType: "ORAL_COMMUNICATION" }),
      revisions: [],
    });

    const result = await service.finalizeAbstract(
      eventId,
      "abs-1",
      { decision: "ACCEPTED", finalType: "ORAL_COMMUNICATION" },
      "admin-1",
    );

    expect(finalizeAbstractTxn).toHaveBeenCalledWith({
      eventId,
      abstractId: "abs-1",
      decision: "ACCEPTED",
      finalType: "ORAL_COMMUNICATION",
      performedBy: "admin-1",
    });
    expect(result).toMatchObject({ status: "ACCEPTED", code: "OC1-01" });
  });

  it("409s when already finalized (no fresh read)", async () => {
    mock(finalizeAbstractTxn).mockResolvedValue({
      ok: false,
      reason: "already_finalized",
    });
    await expectStatus(
      service.finalizeAbstract(eventId, "abs-1", { decision: "REJECTED" }, "admin-1"),
      409,
    );
    expect(getAdminAbstractDetail).not.toHaveBeenCalled();
  });

  it("404s when the abstract is missing", async () => {
    mock(finalizeAbstractTxn).mockResolvedValue({ ok: false, reason: "not_found" });
    await expectStatus(
      service.finalizeAbstract(eventId, "abs-1", { decision: "REJECTED" }, "admin-1"),
      404,
    );
  });

  it("400s (ABS invalid themes) when an accepted abstract has no theme", async () => {
    mock(finalizeAbstractTxn).mockResolvedValue({ ok: false, reason: "no_theme" });
    await expect(
      service.finalizeAbstract(
        eventId,
        "abs-1",
        { decision: "ACCEPTED", finalType: "POSTER" },
        "admin-1",
      ),
    ).rejects.toBeInstanceOf(AppException);
  });
});

describe("reopenAbstract", () => {
  it("reopens then returns a fresh read", async () => {
    mock(reopenAbstractTxn).mockResolvedValue({ ok: true });
    mock(getAdminAbstractDetail).mockResolvedValue({
      ...baseRow({ status: "UNDER_REVIEW" }),
      revisions: [],
    });
    const result = await service.reopenAbstract(eventId, "abs-1", "admin-1");
    expect(result.status).toBe("UNDER_REVIEW");
  });

  it("409s when the abstract is not finalized", async () => {
    mock(reopenAbstractTxn).mockResolvedValue({
      ok: false,
      reason: "not_finalized",
    });
    await expectStatus(service.reopenAbstract(eventId, "abs-1", "admin-1"), 409);
    expect(getAdminAbstractDetail).not.toHaveBeenCalled();
  });
});

describe("markAbstractPresented", () => {
  it("marks then returns a fresh read", async () => {
    mock(markAbstractPresentedTxn).mockResolvedValue({ ok: true });
    mock(getAdminAbstractDetail).mockResolvedValue({
      ...baseRow({ status: "ACCEPTED" }),
      revisions: [],
    });
    const result = await service.markAbstractPresented(
      eventId,
      "abs-1",
      true,
      "admin-1",
    );
    expect(markAbstractPresentedTxn).toHaveBeenCalledWith({
      eventId,
      abstractId: "abs-1",
      presented: true,
      performedBy: "admin-1",
    });
    expect(result.status).toBe("ACCEPTED");
  });

  it("409s when the abstract is not accepted", async () => {
    mock(markAbstractPresentedTxn).mockResolvedValue({
      ok: false,
      reason: "not_accepted",
    });
    await expectStatus(
      service.markAbstractPresented(eventId, "abs-1", true, "admin-1"),
      409,
    );
  });
});

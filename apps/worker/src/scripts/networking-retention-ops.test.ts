import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  purge: vi.fn(),
  countOrphanLogs: vi.fn(),
  purgeOrphanLogs: vi.fn(),
  toErase: vi.fn(),
  erase: vi.fn(),
  photoRefs: vi.fn(),
}));
vi.mock("@app/db", () => ({
  networkingPurgeCandidates: mocks.candidates,
  purgeNetworkingEvent: mocks.purge,
  countOrphanNetworkingEmailLogs: mocks.countOrphanLogs,
  purgeOrphanNetworkingEmailLogs: mocks.purgeOrphanLogs,
  networkingProfilesToErase: mocks.toErase,
  eraseNetworkingProfile: mocks.erase,
  networkingProfilePhotoRefs: mocks.photoRefs,
}));
import type { StorageListPage, StorageProvider } from "@app/integrations";
import {
  parseNetworkingRetentionArgs,
  runEraseWithdrawn,
  runOrphanPhotos,
  runPurgeLeftovers,
} from "./networking-retention-ops";

let lines: string[];
const print = (line: string) => void lines.push(line);
beforeEach(() => {
  vi.resetAllMocks();
  lines = [];
});

describe("arguments", () => {
  it("is a dry run by default, with bounded defaults", () => {
    expect(parseNetworkingRetentionArgs(["erase-withdrawn"])).toEqual({
      command: "erase-withdrawn", apply: false, backupVerified: undefined, eventId: undefined, batchSize: 500, limit: 100, minAgeHours: 24,
    });
    expect(parseNetworkingRetentionArgs(["orphan-photos", "--event", "e"]).batchSize).toBe(1000);
  });

  it("refuses --apply without a verified backup reference", () => {
    expect(() => parseNetworkingRetentionArgs(["purge-leftovers", "--apply"])).toThrow("--backup-verified");
    expect(() => parseNetworkingRetentionArgs(["purge-leftovers", "--apply", "--backup-verified="])).toThrow("--backup-verified");
    expect(parseNetworkingRetentionArgs(["purge-leftovers", "--apply", "--backup-verified=snap-2026-09-25"]))
      .toMatchObject({ apply: true, backupVerified: "snap-2026-09-25" });
  });

  it.each([
    [["wipe-everything"]],
    [[]],
    [["erase-withdrawn", "extra"]],
    [["erase-withdrawn", "--batch-size", "0"]],
    [["erase-withdrawn", "--batch-size", "1e3"]],
    [["erase-withdrawn", "--limit", "5000"]],
    [["orphan-photos", "--min-age-hours", "0"]],
    [["erase-withdrawn", "--unknown"]],
  ])("rejects %j", (argv) => {
    expect(() => parseNetworkingRetentionArgs(argv)).toThrow();
  });
});

describe("purge-leftovers", () => {
  const event = {
    eventId: "e", endDate: new Date("2026-01-01Z"), retentionDays: 90, purgeStartedAt: null, purgedAt: null, profiles: 3,
  };

  it("lists the events and orphaned logs without changing anything", async () => {
    mocks.candidates.mockResolvedValue([event]);
    mocks.countOrphanLogs.mockResolvedValue(4);
    expect(await runPurgeLeftovers(parseNetworkingRetentionArgs(["purge-leftovers"]), print))
      .toEqual({ events: 1, orphanLogs: 4, deleted: 0 });
    expect(mocks.purge).not.toHaveBeenCalled();
    expect(mocks.purgeOrphanLogs).not.toHaveBeenCalled();
    expect(lines).toContain("event=e ended=2026-01-01T00:00:00.000Z retentionDays=90 purgeStarted=- purged=- profiles=3");
    expect(lines.at(-1)).toContain("--apply --backup-verified");
  });

  it("with --apply purges each event without a time budget and logs every non-empty batch", async () => {
    mocks.candidates.mockResolvedValue([event]);
    mocks.countOrphanLogs.mockResolvedValue(2);
    mocks.purge.mockImplementation(async (_eventId, options) => {
      options.onBatch("networking_messages", 500);
      options.onBatch("networking_messages", 20);
      options.onBatch("networking_blocks", 0);
      return { eventId: "e", done: true, deleted: { networking_messages: 520 } };
    });
    mocks.purgeOrphanLogs.mockImplementation(async (options) => {
      options.onBatch(2);
      return 2;
    });
    const options = parseNetworkingRetentionArgs(["purge-leftovers", "--apply", "--backup-verified=snap", "--batch-size", "500"]);
    expect(await runPurgeLeftovers(options, print)).toEqual({ events: 1, orphanLogs: 2, deleted: 522 });
    expect(mocks.purge).toHaveBeenCalledWith("e", expect.objectContaining({ batchSize: 500 }));
    expect(mocks.purge.mock.calls[0][1]).not.toHaveProperty("deadline");
    expect(lines).toEqual(expect.arrayContaining([
      "APPLY purge-leftovers (backup: snap)",
      "batch event=e table=networking_messages deleted=500",
      "batch event=e table=networking_messages deleted=20",
      "purged event=e rows=520",
      "batch table=email_logs (deleted events) deleted=2",
      "Done: 522 row(s) deleted.",
    ]));
    expect(lines.some((line) => line.includes("networking_blocks"))).toBe(false);
  });

  it("scoped to one event, leaves the eventless orphaned logs alone", async () => {
    mocks.candidates.mockResolvedValue([]);
    await runPurgeLeftovers(parseNetworkingRetentionArgs(["purge-leftovers", "--event", "e", "--apply", "--backup-verified=snap"]), print);
    expect(mocks.candidates).toHaveBeenCalledWith("e");
    expect(mocks.countOrphanLogs).not.toHaveBeenCalled();
    expect(mocks.purgeOrphanLogs).not.toHaveBeenCalled();
  });
});

describe("erase-withdrawn", () => {
  const due = [
    { profileId: "p", eventId: "e", withdrawnAt: new Date("2026-08-01Z") },
    { profileId: "q", eventId: "e", withdrawnAt: new Date("2026-08-02Z") },
  ];

  it("lists the profiles past the configured window without erasing", async () => {
    mocks.toErase.mockResolvedValue(due);
    expect(await runEraseWithdrawn(parseNetworkingRetentionArgs(["erase-withdrawn", "--limit", "2"]), 30, print)).toEqual({ due: 2, erased: 0 });
    expect(mocks.toErase).toHaveBeenCalledWith({ eraseDays: 30, eventId: undefined, limit: 2 });
    expect(mocks.erase).not.toHaveBeenCalled();
    expect(lines).toContain("2 withdrawn profile(s) past the 30-day window (first 2; run again for more).");
  });

  it("with --apply erases them one by one, logging each batch", async () => {
    mocks.toErase.mockResolvedValue(due);
    mocks.erase.mockImplementation(async (profileId, options) => {
      options.onBatch("networking_messages", 3);
      options.onBatch("networking_audit", 0);
      options.onBatch("networking_profiles", 1);
      return { profileId, eventId: "e", done: true, erased: true, deleted: { networking_messages: 3 } };
    });
    const options = parseNetworkingRetentionArgs(["erase-withdrawn", "--apply", "--backup-verified=snap", "--batch-size", "50"]);
    expect(await runEraseWithdrawn(options, 30, print)).toEqual({ due: 2, erased: 2 });
    expect(mocks.erase).toHaveBeenCalledWith("p", expect.objectContaining({ batchSize: 50 }));
    expect(lines).toEqual(expect.arrayContaining([
      "batch profile=p table=networking_messages deleted=3",
      "batch profile=p table=networking_profiles scrubbed=1",
      "batch profile=q table=networking_messages deleted=3",
      "Done: 2 profile(s) erased.",
    ]));
  });
});

describe("orphan-photos", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const old = new Date(now - 48 * 3_600_000);
  const fresh = new Date(now - 3_600_000);
  function storage(pages: StorageListPage[]) {
    const deleted: string[] = [];
    const provider = {
      list: vi.fn(async () => pages.shift()!),
      delete: vi.fn(async (key: string) => { deleted.push(key); }),
    };
    return { provider: provider as unknown as StorageProvider & typeof provider, deleted };
  }
  const pages = (): StorageListPage[] => [
    {
      items: [
        // Current photo (column), current photo (override only), replaced photo, withdrawn profile's photo.
        { key: "networking/e/profiles/p/current.webp", updatedAt: old, size: 1 },
        { key: "networking/e/profiles/o/override.webp", updatedAt: old, size: 1 },
        { key: "networking/e/profiles/p/replaced.webp", updatedAt: old, size: 1 },
        { key: "networking/e/profiles/gone/photo.webp", updatedAt: old, size: 1 },
        // Never touched: a fresh upload, unknown age, branding, reports, nested or foreign keys.
        { key: "networking/e/profiles/p/fresh.webp", updatedAt: fresh, size: 1 },
        { key: "networking/e/profiles/p/unknown-age.webp", updatedAt: null, size: 1 },
        { key: "networking/e/branding/logo.webp", updatedAt: old, size: 1 },
        { key: "networking/reports/e/report.pdf", updatedAt: old, size: 1 },
        { key: "networking/e/profiles/p/nested/x.webp", updatedAt: old, size: 1 },
      ],
      nextCursor: "page-2",
    },
    { items: [{ key: "networking/e2/profiles/p/moved.webp", updatedAt: old, size: 1 }], nextCursor: null },
  ];
  beforeEach(() => {
    mocks.photoRefs.mockImplementation(async (ids: string[]) => [
      { id: "p", eventId: "e", photoUrl: "https://cdn.test/networking/e/profiles/p/current.webp", overridePhotoUrl: null },
      { id: "o", eventId: "e", photoUrl: null, overridePhotoUrl: "https://storage.googleapis.com/bucket/networking/e/profiles/o/override.webp" },
    ].filter((ref) => ids.includes(ref.id)));
  });

  it("reports unreferenced profile photos older than the minimum age, page by page, deleting nothing", async () => {
    const { provider } = storage(pages());
    const totals = await runOrphanPhotos(parseNetworkingRetentionArgs(["orphan-photos"]), provider, print, now);
    expect(totals).toEqual({ listed: 10, orphans: 3, deleted: 0, missing: 0 });
    expect(provider.list.mock.calls).toEqual([
      ["networking/", { cursor: undefined, limit: 1000 }],
      ["networking/", { cursor: "page-2", limit: 1000 }],
    ]);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.startsWith("orphan "))).toEqual([
      `orphan key=networking/e/profiles/p/replaced.webp reason=not-referenced updatedAt=${old.toISOString()}`,
      `orphan key=networking/e/profiles/gone/photo.webp reason=profile-missing updatedAt=${old.toISOString()}`,
      // Profile p belongs to event e: the same id under another event is not its photo.
      `orphan key=networking/e2/profiles/p/moved.webp reason=not-referenced updatedAt=${old.toISOString()}`,
    ]);
    expect(lines).toContain("page=1 listed=9 photos=4 orphans=2");
  });

  it("with --apply deletes the orphans only, counting an already missing object as gone", async () => {
    const { provider, deleted } = storage(pages());
    provider.delete.mockImplementation(async (key: string) => {
      if (key.includes("gone")) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      deleted.push(key);
    });
    const options = parseNetworkingRetentionArgs(["orphan-photos", "--apply", "--backup-verified=bucket-copy", "--event", "e", "--min-age-hours", "2"]);
    const totals = await runOrphanPhotos(options, provider, print, now);
    expect(provider.list).toHaveBeenCalledWith("networking/e/profiles/", { cursor: undefined, limit: 1000 });
    expect(deleted).toEqual(["networking/e/profiles/p/replaced.webp", "networking/e2/profiles/p/moved.webp"]);
    expect(totals).toEqual({ listed: 10, orphans: 3, deleted: 2, missing: 1 });
    expect(lines).toContain("page=1 listed=9 photos=4 orphans=2 deleted=1");
  });

  it("stops on any other storage failure", async () => {
    const { provider } = storage(pages());
    provider.delete.mockRejectedValue(Object.assign(new Error("AccessDenied"), { $metadata: { httpStatusCode: 403 } }));
    const options = parseNetworkingRetentionArgs(["orphan-photos", "--apply", "--backup-verified=bucket-copy"]);
    await expect(runOrphanPhotos(options, provider, print, now)).rejects.toThrow("AccessDenied");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  setRender: vi.fn(),
  derive: vi.fn(),
}));
vi.mock("@app/db", () => ({
  listCertificateTemplatesMissingRenderImage: mocks.list,
  setCertificateTemplateRenderImage: mocks.setRender,
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deriveCertificateRenderImage: mocks.derive,
}));

import { StorageObjectNotFoundError, type StorageProvider } from "@app/integrations";
import {
  BACKFILL_CERTIFICATE_RENDER_PAGE_SIZE,
  parseBackfillCertificateRenderArgs,
  runBackfillCertificateRenders,
} from "./backfill-certificate-renders-ops";

const storage = {
  download: vi.fn(),
  uploadPrivate: vi.fn(),
  delete: vi.fn(),
};
const provider = storage as unknown as StorageProvider;

function template(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `tpl-${String(n).padStart(3, "0")}`,
    eventId: "evt-1",
    templateUrl: `https://cdn.example.com/evt-1/certificates/tpl-${n}-u.png`,
    ...overrides,
  };
}

/** The list query over `rows`, honoring afterId + limit like the SQL. */
function listFrom(rows: Array<ReturnType<typeof template>>) {
  mocks.list.mockImplementation(async (options: { afterId?: string; limit: number }) =>
    rows.filter((row) => options.afterId === undefined || row.id > options.afterId).slice(0, options.limit),
  );
}

let lines: string[];
const print = (line: string) => void lines.push(line);

beforeEach(() => {
  vi.resetAllMocks();
  lines = [];
  storage.download.mockResolvedValue({ buffer: Buffer.from("original"), contentType: "image/png" });
  storage.uploadPrivate.mockImplementation(async (_b: Buffer, key: string) => key);
  storage.delete.mockResolvedValue(undefined);
  mocks.derive.mockResolvedValue({
    buffer: Buffer.from("jpeg"),
    width: 3508,
    height: 2480,
    contentType: "image/jpeg",
  });
  mocks.setRender.mockResolvedValue(true);
});

describe("arguments", () => {
  it("is a dry run by default, 1000 templates per run", () => {
    expect(parseBackfillCertificateRenderArgs([])).toEqual({
      apply: false,
      eventId: undefined,
      templateIds: undefined,
      limit: 1000,
    });
  });

  it("takes --apply, --event, repeated --template and --limit", () => {
    expect(
      parseBackfillCertificateRenderArgs([
        "--apply", "--event", "evt-1", "--template", "a", "--template", "b", "--limit", "20",
      ]),
    ).toEqual({ apply: true, eventId: "evt-1", templateIds: ["a", "b"], limit: 20 });
    expect(parseBackfillCertificateRenderArgs(["--help"])).toBe("help");
  });

  it("refuses a bad --limit and unknown options", () => {
    expect(() => parseBackfillCertificateRenderArgs(["--limit", "0"])).toThrow("--limit");
    expect(() => parseBackfillCertificateRenderArgs(["--limit", "10001"])).toThrow("--limit");
    expect(() => parseBackfillCertificateRenderArgs(["--limit", "2.5"])).toThrow("--limit");
    expect(() => parseBackfillCertificateRenderArgs(["--force"])).toThrow();
  });
});

describe("dry run", () => {
  it("lists the templates and counts them; never touches storage or the rows", async () => {
    listFrom([template(1), template(2)]);

    const counts = await runBackfillCertificateRenders(
      { apply: false, limit: 1000 },
      provider,
      print,
    );

    expect(counts).toEqual({ candidates: 2, rendered: 0, changed: 0, failed: 0 });
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.uploadPrivate).not.toHaveBeenCalled();
    expect(mocks.setRender).not.toHaveBeenCalled();
    expect(lines[0]).toMatch(/^Dry run backfill-certificate-renders: nothing is changed\.$/);
    expect(lines.filter((l) => l.startsWith("candidate "))).toHaveLength(2);
    expect(lines).toContain("2 template(s) without a render image.");
    expect(lines).toContain("Re-run with --apply to store their render images.");
  });

  it("pages through every template by id and stops at --limit", async () => {
    const rows = Array.from({ length: BACKFILL_CERTIFICATE_RENDER_PAGE_SIZE + 10 }, (_, i) => template(i));
    listFrom(rows);

    const all = await runBackfillCertificateRenders({ apply: false, limit: 1000 }, provider, print);
    expect(all.candidates).toBe(rows.length);
    expect(mocks.list.mock.calls[1][0]).toMatchObject({ afterId: rows[BACKFILL_CERTIFICATE_RENDER_PAGE_SIZE - 1].id });

    lines = [];
    const limited = await runBackfillCertificateRenders({ apply: false, limit: 5 }, provider, print);
    expect(limited.candidates).toBe(5);
    expect(lines.at(-1)).toBe("Stopped at --limit 5; run again for the rest.");
  });

  it("passes the event and template filters to the query", async () => {
    listFrom([]);
    await runBackfillCertificateRenders(
      { apply: false, eventId: "evt-1", templateIds: ["tpl-001"], limit: 10 },
      provider,
      print,
    );
    expect(mocks.list).toHaveBeenCalledWith({
      eventId: "evt-1",
      templateIds: ["tpl-001"],
      afterId: undefined,
      limit: 10,
    });
  });
});

describe("--apply", () => {
  it("derives from the original, stores beside it under a fresh key, then records it guarded by the original url", async () => {
    const row = template(1);
    listFrom([row]);

    const counts = await runBackfillCertificateRenders({ apply: true, limit: 1000 }, provider, print);

    expect(counts).toEqual({ candidates: 1, rendered: 1, changed: 0, failed: 0 });
    expect(storage.download).toHaveBeenCalledWith("evt-1/certificates/tpl-1-u.png");
    expect(mocks.derive).toHaveBeenCalledWith(Buffer.from("original"));
    const [buffer, key, contentType] = storage.uploadPrivate.mock.calls[0];
    expect(buffer).toEqual(Buffer.from("jpeg"));
    expect(key).toMatch(/^evt-1\/certificates\/tpl-001-[0-9a-f-]{36}-render\.jpg$/);
    expect(contentType).toBe("image/jpeg");
    expect(mocks.setRender).toHaveBeenCalledWith(row.id, row.templateUrl, {
      renderImageKey: key,
      renderImageWidth: 3508,
      renderImageHeight: 2480,
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe("Done: candidates=1 rendered=1 changed=0 failed=0.");
  });

  it("a template changed during the run: nothing recorded and its own new object deleted", async () => {
    listFrom([template(1)]);
    mocks.setRender.mockResolvedValue(false);

    const counts = await runBackfillCertificateRenders({ apply: true, limit: 1000 }, provider, print);

    expect(counts).toMatchObject({ rendered: 0, changed: 1 });
    expect(storage.delete).toHaveBeenCalledWith(storage.uploadPrivate.mock.calls[0][1]);
  });

  it("counts failures per template and carries on", async () => {
    listFrom([
      template(1, { templateUrl: "bare-key.png" }),
      template(2),
      template(3),
      template(4),
    ]);
    storage.download
      .mockRejectedValueOnce(new StorageObjectNotFoundError("evt-1/certificates/tpl-2-u.png"))
      .mockResolvedValue({ buffer: Buffer.from("original"), contentType: "image/png" });
    mocks.derive
      .mockRejectedValueOnce(new Error("Input image exceeds pixel limit"))
      .mockResolvedValue({ buffer: Buffer.from("jpeg"), width: 10, height: 10, contentType: "image/jpeg" });

    const counts = await runBackfillCertificateRenders({ apply: true, limit: 1000 }, provider, print);

    expect(counts).toEqual({ candidates: 4, rendered: 1, changed: 0, failed: 3 });
    expect(lines).toContain(
      "failed template=tpl-001 event=evt-1: image URL is not a supported storage location",
    );
    expect(lines).toContain("failed template=tpl-002 event=evt-1: original image missing from storage");
    expect(lines.find((l) => l.startsWith("failed template=tpl-003"))).toMatch(/cannot be decoded/);
    expect(mocks.setRender).toHaveBeenCalledTimes(1);
    expect(storage.uploadPrivate).toHaveBeenCalledTimes(1);
  });
});

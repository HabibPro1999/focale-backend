import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  getDb,
  listCertificateTemplatesMissingRenderImage,
  setCertificateTemplateRenderImage,
  type CertificateTemplateMissingRender,
} from "@app/db";
import {
  certificateRenderImageKey,
  deriveCertificateRenderImage,
  extractStorageKeyFromUrl,
  isStorageObjectMissing,
  type StorageProvider,
} from "@app/integrations";

// Backfill certificate render images (plan 3.8). Templates uploaded before 3.8
// have no render image, so the worker embeds their original image (for a PNG,
// a pure-JavaScript decode per certificate). Dry run by default: lists those
// templates. --apply derives each render image exactly as an upload does,
// stores it beside the original under a fresh key, and records it only while
// the template still shows that original and has no render image; otherwise
// the new object is deleted. Nothing referenced is ever overwritten or deleted.

export interface BackfillCertificateRenderOptions {
  apply: boolean;
  eventId?: string;
  templateIds?: string[];
  /** Most templates handled in one run. */
  limit: number;
}

/** Templates read per query. */
export const BACKFILL_CERTIFICATE_RENDER_PAGE_SIZE = 50;

export const BACKFILL_CERTIFICATE_RENDERS_USAGE = [
  "Usage: backfill-certificate-renders [--apply] [--event <id>] [--template <id>]... [--limit <n>]",
  "  (image: node apps/worker/dist/scripts/backfill-certificate-renders.js ...)",
  "",
  "Dry run by default: lists templates with an uploaded image and no render image.",
  "--apply stores a render image for each (reads DATABASE_URL and the storage settings).",
  "--limit 1-10000 templates per run (default 1000); run again for the rest.",
].join("\n");

export function parseBackfillCertificateRenderArgs(
  argv: string[],
): BackfillCertificateRenderOptions | "help" {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      event: { type: "string" },
      template: { type: "string", multiple: true },
      limit: { type: "string" },
    },
  });
  if (values.help) return "help";
  let limit = 1000;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(values.limit.trim()) || limit < 1 || limit > 10_000) {
      throw new Error("--limit must be an integer from 1 to 10000");
    }
  }
  const templateIds = values.template?.map((id) => id.trim()).filter(Boolean);
  return {
    apply: values.apply === true,
    eventId: values.event?.trim() || undefined,
    templateIds: templateIds?.length ? templateIds : undefined,
    limit,
  };
}

export interface BackfillCertificateRenderCounts {
  /** Templates without a render image that this run looked at. */
  candidates: number;
  /** Render images stored and recorded (--apply). */
  rendered: number;
  /** The template changed during the run (new upload, or rendered by another run). */
  changed: number;
  /** Could not be rendered (bad location, original missing, undecodable image, storage error). */
  failed: number;
}

type Outcome =
  | { status: "rendered"; key: string; width: number; height: number }
  | { status: "changed" }
  | { status: "failed"; reason: string };

async function backfillOne(
  template: CertificateTemplateMissingRender,
  storage: StorageProvider,
): Promise<Outcome> {
  const originalKey = extractStorageKeyFromUrl(template.templateUrl, { allowBareKey: false });
  if (!originalKey) {
    return { status: "failed", reason: "image URL is not a supported storage location" };
  }

  let original: Buffer;
  try {
    original = (await storage.download(originalKey)).buffer;
  } catch (error) {
    return {
      status: "failed",
      reason: isStorageObjectMissing(error)
        ? "original image missing from storage"
        : `download failed: ${(error as Error).message}`,
    };
  }

  let render: Awaited<ReturnType<typeof deriveCertificateRenderImage>>;
  try {
    render = await deriveCertificateRenderImage(original);
  } catch (error) {
    return {
      status: "failed",
      reason: `image cannot be decoded within the upload limits: ${(error as Error).message}`,
    };
  }

  const key = certificateRenderImageKey(template.eventId, template.id, randomUUID());
  try {
    await storage.uploadPrivate(render.buffer, key, render.contentType);
  } catch (error) {
    return { status: "failed", reason: `upload failed: ${(error as Error).message}` };
  }

  const recorded = await setCertificateTemplateRenderImage(template.id, template.templateUrl, {
    renderImageKey: key,
    renderImageWidth: render.width,
    renderImageHeight: render.height,
  }, getDb());
  if (!recorded) {
    // Our key is fresh and unreferenced: safe to remove.
    await storage.delete(key).catch(() => undefined);
    return { status: "changed" };
  }
  return { status: "rendered", key, width: render.width, height: render.height };
}

export async function runBackfillCertificateRenders(
  options: BackfillCertificateRenderOptions,
  storage: StorageProvider,
  print: (line: string) => void,
): Promise<BackfillCertificateRenderCounts> {
  const scope = [
    options.eventId ? `event=${options.eventId}` : "",
    options.templateIds ? `templates=${options.templateIds.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  print(
    options.apply
      ? `APPLY backfill-certificate-renders${scope ? ` ${scope}` : ""}`
      : `Dry run backfill-certificate-renders${scope ? ` ${scope}` : ""}: nothing is changed.`,
  );

  const counts: BackfillCertificateRenderCounts = { candidates: 0, rendered: 0, changed: 0, failed: 0 };
  let afterId: string | undefined;
  let more = true;
  while (more && counts.candidates < options.limit) {
    const pageSize = Math.min(BACKFILL_CERTIFICATE_RENDER_PAGE_SIZE, options.limit - counts.candidates);
    const page = await listCertificateTemplatesMissingRenderImage({
      eventId: options.eventId,
      templateIds: options.templateIds,
      afterId,
      limit: pageSize,
    });
    more = page.length === pageSize;
    for (const template of page) {
      counts.candidates++;
      const subject = `template=${template.id} event=${template.eventId}`;
      if (!options.apply) {
        print(`candidate ${subject} url=${template.templateUrl}`);
        continue;
      }
      const outcome = await backfillOne(template, storage);
      counts[outcome.status]++;
      if (outcome.status === "rendered") {
        print(`rendered ${subject} key=${outcome.key} size=${outcome.width}x${outcome.height}`);
      } else if (outcome.status === "changed") {
        print(`changed ${subject}: the template changed during the run; nothing recorded`);
      } else {
        print(`failed ${subject}: ${outcome.reason}`);
      }
    }
    afterId = page.at(-1)?.id;
  }

  if (options.apply) {
    print(
      `Done: candidates=${counts.candidates} rendered=${counts.rendered} changed=${counts.changed} failed=${counts.failed}.`,
    );
  } else {
    print(`${counts.candidates} template(s) without a render image.`);
    if (counts.candidates > 0) print("Re-run with --apply to store their render images.");
  }
  if (more && counts.candidates >= options.limit) {
    print(`Stopped at --limit ${options.limit}; run again for the rest.`);
  }
  return counts;
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "@/database/client.js";
import {
  AbstractBookJobStatus,
  AbstractBookOrder,
  AbstractStatus,
  type AbstractBookJob,
  type Prisma,
} from "@/generated/prisma/client.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { logger } from "@shared/utils/logger.js";
import { FINAL_STATUSES, FINAL_TYPE_SORT_ORDER } from "./abstracts.constants.js";
import { abstractHtmlToText } from "./abstracts.html.js";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const COLUMN_GAP = 18;
const COLUMN_WIDTH = (A4[0] - MARGIN * 2 - COLUMN_GAP) / 2;
const FULL_WIDTH = A4[0] - MARGIN * 2;
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ABSTRACT_BOOK_LEASE_MS = 60 * 60 * 1000;
const ABSTRACT_BOOK_HEARTBEAT_MS = 60 * 1000;
const ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS = 60 * 60 * 1000;
const ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE = 100;
const DEFAULT_WORKER_ID = `abstract-book:${hostname()}:${process.pid}:${randomUUID()}`;

export interface ProcessAbstractBookJobsOptions {
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

function abstractBookRetryDelayMs(failedAttemptCount: number): number {
  if (failedAttemptCount <= 1) return 60 * 1000;
  if (failedAttemptCount === 2) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

function nextAbstractBookAttemptAt(failedAttemptCount: number, from = new Date()): Date {
  return new Date(from.getTime() + abstractBookRetryDelayMs(failedAttemptCount));
}

function clearAbstractBookLeaseFields() {
  return {
    lockedAt: null,
    lockedUntil: null,
    lockedBy: null,
  };
}

type BookAbstract = Prisma.AbstractGetPayload<{
  include: {
    themes: { include: { theme: { select: { label: true; sortOrder: true } } } };
  };
}>;

type BookConfig = {
  bookFontFamily: string;
  bookFontSize: number;
  bookLineSpacing: number;
  bookOrder: AbstractBookOrder;
  bookIncludeAuthorNames: boolean;
};

function formatJob(job: AbstractBookJob, downloadUrl?: string | null) {
  return {
    id: job.id,
    eventId: job.eventId,
    requestedBy: job.requestedBy,
    status: job.status,
    storageKey: job.storageKey,
    downloadUrl: downloadUrl ?? null,
    errorMessage: job.errorMessage,
    includedCount: job.includedCount,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    lastAttemptAt: job.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

async function jobDownloadUrl(job: AbstractBookJob): Promise<string | null> {
  if (job.status !== AbstractBookJobStatus.COMPLETED || !job.storageKey) return null;
  return getStorageProvider().getSignedUrl(job.storageKey, SIGNED_URL_TTL_SECONDS);
}

function getContentTitle(content: Prisma.JsonValue): string {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const title = (content as Record<string, unknown>).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "Untitled abstract";
}

function getContentSections(content: Prisma.JsonValue): Array<{ label: string; text: string }> {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const record = content as Record<string, unknown>;
  if (record.mode === "STRUCTURED") {
    return [
      ["Introduction", record.introduction],
      ["Objective", record.objective],
      ["Methods", record.methods],
      ["Results", record.results],
      ["Conclusion", record.conclusion],
    ]
      .map(([label, value]) => ({
        label: String(label),
        text: typeof value === "string" ? abstractHtmlToText(value) : "",
      }))
      .filter((section) => section.text.length > 0);
  }
  const body = typeof record.body === "string" ? abstractHtmlToText(record.body) : "";
  return body ? [{ label: "Abstract", text: body }] : [];
}

function withAffiliation(name: string, affiliation: string | undefined): string {
  const trimmed = affiliation?.trim();
  return trimmed ? `${name} (${trimmed})` : name;
}

function getAuthorLine(abstract: BookAbstract): string {
  const primaryName = `${abstract.authorFirstName} ${abstract.authorLastName}`.trim();
  const names = [
    withAffiliation(primaryName, abstract.authorAffiliation ?? undefined),
  ];
  if (Array.isArray(abstract.coAuthors)) {
    for (const coAuthor of abstract.coAuthors) {
      if (!coAuthor || typeof coAuthor !== "object" || Array.isArray(coAuthor)) continue;
      const record = coAuthor as Record<string, unknown>;
      const firstName = typeof record.firstName === "string" ? record.firstName : "";
      const lastName = typeof record.lastName === "string" ? record.lastName : "";
      const affiliation = typeof record.affiliation === "string" ? record.affiliation : undefined;
      const fullName = `${firstName} ${lastName}`.trim();
      if (fullName) names.push(withAffiliation(fullName, affiliation));
    }
  }
  return names.filter(Boolean).join(", ");
}

function typeLabel(value: string | null): string {
  if (value === "CONFERENCE") return "Conférence";
  if (value === "ORAL_COMMUNICATION") return "Communication orale";
  if (value === "POSTER") return "Communication affichée";
  return "—";
}

function themeLabel(abstract: BookAbstract): string {
  return abstract.themes
    .map((link) => link.theme.label)
    .filter(Boolean)
    .join(", ");
}

function sortAbstracts(abstracts: BookAbstract[], order: AbstractBookOrder): BookAbstract[] {
  const copy = [...abstracts];
  if (order === AbstractBookOrder.BY_SUBMISSION_ORDER) {
    return copy.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  if (order === AbstractBookOrder.BY_THEME) {
    return copy.sort((a, b) => {
      const themeA = a.themes[0]?.theme.sortOrder ?? 0;
      const themeB = b.themes[0]?.theme.sortOrder ?? 0;
      if (themeA !== themeB) return themeA - themeB;
      const typeA = a.finalType ? FINAL_TYPE_SORT_ORDER[a.finalType] : 99;
      const typeB = b.finalType ? FINAL_TYPE_SORT_ORDER[b.finalType] : 99;
      if (typeA !== typeB) return typeA - typeB;
      return (a.codeNumber ?? 0) - (b.codeNumber ?? 0);
    });
  }
  return copy.sort((a, b) => (a.codeNumber ?? 0) - (b.codeNumber ?? 0));
}

function fontForFamily(family: string): { regular: StandardFonts; bold: StandardFonts } {
  const normalized = family.toLocaleLowerCase();
  if (normalized.includes("times")) {
    return { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold };
  }
  if (normalized.includes("courier")) {
    return { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold };
  }
  return { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold };
}

// pdf-lib's StandardFonts use WinAnsi (CP1252) encoding and THROW on any
// character they cannot encode (emoji, Greek letters, CJK, …), which would
// abort the whole book. These extra Unicode code points are the ones CP1252
// maps in its 0x80–0x9F range; everything in Latin-1 (≤ 0xFF) is also fine.
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function toWinAnsiSafe(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === 0x09 ||
      code === 0x0a ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WINANSI_EXTRA.has(code)
    ) {
      result += char;
    } else {
      result += "?";
    }
  }
  return result;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = toWinAnsiSafe(text).split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

class PdfWriter {
  private page: PDFPage;
  private y: number;
  private column = 0;

  constructor(
    private readonly pdfDoc: PDFDocument,
    private readonly regularFont: PDFFont,
    private readonly boldFont: PDFFont,
    private readonly fontSize: number,
    private readonly lineHeight: number,
  ) {
    this.page = pdfDoc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  addPage() {
    this.page = this.pdfDoc.addPage(A4);
    this.y = A4[1] - MARGIN;
    this.column = 0;
  }

  private columnX() {
    return MARGIN + this.column * (COLUMN_WIDTH + COLUMN_GAP);
  }

  private nextColumnOrPage() {
    if (this.column === 0) {
      this.column = 1;
      this.y = A4[1] - MARGIN;
    } else {
      this.addPage();
    }
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.nextColumnOrPage();
  }

  move(delta: number) {
    this.y -= delta;
  }

  text(
    text: string,
    options?: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; gapAfter?: number },
  ) {
    const size = options?.size ?? this.fontSize;
    const font = options?.bold ? this.boldFont : this.regularFont;
    const lineHeight = Math.max(size * 1.25, this.lineHeight);
    const lines = wrapText(text, font, size, COLUMN_WIDTH);
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.nextColumnOrPage();
      if (line) {
        this.page.drawText(line, {
          x: this.columnX(),
          y: this.y,
          size,
          font,
          color: options?.color ?? rgb(0.1, 0.1, 0.1),
        });
      }
      this.y -= lineHeight;
    }
    this.y -= options?.gapAfter ?? 0;
  }

  fullWidthText(
    text: string,
    options?: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb>; gapAfter?: number },
  ) {
    if (this.column !== 0) this.addPage();
    const size = options?.size ?? this.fontSize;
    const font = options?.bold ? this.boldFont : this.regularFont;
    const lineHeight = Math.max(size * 1.25, this.lineHeight);
    const lines = wrapText(text, font, size, FULL_WIDTH);
    this.ensure(Math.max(lineHeight, lines.length * lineHeight));
    for (const line of lines) {
      if (this.y - lineHeight < MARGIN) this.addPage();
      if (line) {
        this.page.drawText(line, {
          x: MARGIN,
          y: this.y,
          size,
          font,
          color: options?.color ?? rgb(0.1, 0.1, 0.1),
        });
      }
      this.y -= lineHeight;
    }
    this.y -= options?.gapAfter ?? 0;
  }
}

export async function generateAbstractBookPdf(eventId: string): Promise<{ buffer: Buffer; includedCount: number }> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      abstractConfig: {
        select: {
          bookFontFamily: true,
          bookFontSize: true,
          bookLineSpacing: true,
          bookOrder: true,
          bookIncludeAuthorNames: true,
        },
      },
    },
  });
  if (!event) throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  if (!event.abstractConfig) {
    throw new AppError("Abstract configuration not found", 404, ErrorCodes.NOT_FOUND);
  }

  const config: BookConfig = event.abstractConfig;
  const abstracts = sortAbstracts(
    await prisma.abstract.findMany({
      where: { eventId, status: AbstractStatus.ACCEPTED },
      include: {
        themes: { include: { theme: { select: { label: true, sortOrder: true } } } },
      },
      orderBy: { codeNumber: "asc" },
    }),
    config.bookOrder,
  );

  const pdfDoc = await PDFDocument.create();
  const fontChoice = fontForFamily(config.bookFontFamily);
  const regularFont = await pdfDoc.embedFont(fontChoice.regular);
  const boldFont = await pdfDoc.embedFont(fontChoice.bold);
  const writer = new PdfWriter(
    pdfDoc,
    regularFont,
    boldFont,
    config.bookFontSize,
    config.bookFontSize * config.bookLineSpacing,
  );

  writer.fullWidthText(event.name, { bold: true, size: 22, gapAfter: 8 });
  writer.fullWidthText("Abstract Book", { bold: true, size: 16, gapAfter: 20, color: rgb(0.25, 0.25, 0.25) });

  if (abstracts.length === 0) {
    writer.text("No accepted abstracts are available for this book.", { gapAfter: 10 });
  }

  let currentGroup = "";
  abstracts.forEach((abstract, index) => {
    if (index > 0) writer.move(8);
    const group = `${themeLabel(abstract) || "No theme"} · ${typeLabel(abstract.finalType)}`;
    if (config.bookOrder === AbstractBookOrder.BY_THEME && group !== currentGroup) {
      currentGroup = group;
      writer.text(group, {
        bold: true,
        size: Math.max(9, config.bookFontSize + 1),
        color: rgb(0.18, 0.18, 0.18),
        gapAfter: 6,
      });
    }
    writer.ensure(120);
    writer.text(`${abstract.code ?? "No code"} ${getContentTitle(abstract.content)}`, {
      bold: true,
      size: config.bookFontSize + 2,
      gapAfter: 6,
    });
    if (config.bookIncludeAuthorNames) {
      writer.text(getAuthorLine(abstract), { bold: true, gapAfter: 4 });
    }
    writer.text(`Correspondence: ${abstract.authorEmail}`, {
      size: Math.max(8, config.bookFontSize - 1),
      color: rgb(0.35, 0.35, 0.35),
      gapAfter: 8,
    });

    for (const section of getContentSections(abstract.content)) {
      writer.text(section.label, { bold: true, gapAfter: 2 });
      writer.text(section.text, { gapAfter: 8 });
    }
  });

  const bytes = await pdfDoc.save();
  return { buffer: Buffer.from(bytes), includedCount: abstracts.length };
}

export async function enqueueAbstractBookJob(eventId: string, requestedBy: string) {
  const [config, unfinishedCount] = await Promise.all([
    prisma.abstractConfig.findUnique({ where: { eventId }, select: { id: true } }),
    prisma.abstract.count({
      where: {
        eventId,
        status: { notIn: FINAL_STATUSES },
      },
    }),
  ]);

  if (!config) throw new AppError("Abstract configuration not found", 404, ErrorCodes.NOT_FOUND);
  if (unfinishedCount > 0) {
    throw new AppError(
      "Abstract Book can only be generated after all abstracts are finalized.",
      409,
      ErrorCodes.INVALID_STATUS_TRANSITION,
      { unfinishedCount },
    );
  }

  const job = await prisma.abstractBookJob.create({
    data: {
      eventId,
      requestedBy,
      status: AbstractBookJobStatus.PENDING,
    },
  });

  await auditLog(prisma, {
    entityType: "AbstractBookJob",
    entityId: job.id,
    action: "enqueue",
    changes: { status: { old: null, new: AbstractBookJobStatus.PENDING } },
    performedBy: requestedBy,
  });

  return formatJob(job);
}

export async function listAbstractBookJobs(eventId: string) {
  const jobs = await prisma.abstractBookJob.findMany({
    where: { eventId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return Promise.all(jobs.map(async (job) => formatJob(job, await jobDownloadUrl(job))));
}

export async function getAbstractBookJob(eventId: string, jobId: string) {
  const job = await prisma.abstractBookJob.findUnique({ where: { id: jobId } });
  if (!job || job.eventId !== eventId) {
    throw new AppError("Abstract Book job not found", 404, ErrorCodes.NOT_FOUND);
  }
  return formatJob(job, await jobDownloadUrl(job));
}

export async function recoverStaleAbstractBookJobs(now = new Date()) {
  const retry1At = nextAbstractBookAttemptAt(1, now);
  const retry2At = nextAbstractBookAttemptAt(2, now);
  const retryLaterAt = nextAbstractBookAttemptAt(3, now);

  const requeued = await prisma.$executeRawUnsafe(
    `UPDATE "abstract_book_jobs"
     SET
       "status" = 'PENDING',
       "updated_at" = $1,
       "locked_at" = NULL,
       "locked_until" = NULL,
       "locked_by" = NULL,
       "next_attempt_at" = CASE
         WHEN "attempt_count" <= 1 THEN $2
         WHEN "attempt_count" = 2 THEN $3
         ELSE $4
       END,
       "error_message" = COALESCE("error_message", 'Abstract Book job lease expired; requeued for retry')
     WHERE "status" = 'RUNNING'
       AND ("locked_until" IS NULL OR "locked_until" < $1)
       AND "attempt_count" < "max_attempts"`,
    now,
    retry1At,
    retry2At,
    retryLaterAt,
  );

  const deadLettered = await prisma.$executeRawUnsafe(
    `UPDATE "abstract_book_jobs"
     SET
       "status" = 'FAILED',
       "updated_at" = $1,
       "completed_at" = $1,
       "locked_at" = NULL,
       "locked_until" = NULL,
       "locked_by" = NULL,
       "next_attempt_at" = NULL,
       "error_message" = COALESCE("error_message", 'Abstract Book job lease expired and retry limit was exhausted')
     WHERE "status" = 'RUNNING'
       AND ("locked_until" IS NULL OR "locked_until" < $1)
       AND "attempt_count" >= "max_attempts"`,
    now,
  );

  if (requeued > 0 || deadLettered > 0) {
    logger.warn({ requeued, deadLettered }, "Recovered stale Abstract Book job leases");
  }

  return { requeued, deadLettered };
}

type ClaimedAbstractBookJob = AbstractBookJob;

async function claimAbstractBookJobs(
  limit: number,
  workerId: string,
  leaseMs: number,
  now = new Date(),
): Promise<ClaimedAbstractBookJob[]> {
  const lockedUntil = new Date(now.getTime() + leaseMs);
  return prisma.$queryRawUnsafe<ClaimedAbstractBookJob[]>(
    `UPDATE "abstract_book_jobs"
     SET
       "status" = 'RUNNING',
       "updated_at" = $1,
       "started_at" = COALESCE("started_at", $1),
       "locked_at" = $1,
       "locked_until" = $2,
       "locked_by" = $3,
       "last_attempt_at" = $1,
       "attempt_count" = "attempt_count" + 1,
       "error_message" = NULL
     WHERE "id" IN (
       SELECT "id" FROM "abstract_book_jobs"
       WHERE "status" = 'PENDING'
         AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $1)
         AND "attempt_count" < "max_attempts"
       ORDER BY "created_at" ASC
       LIMIT $4
       FOR UPDATE SKIP LOCKED
     )
     RETURNING
       "id",
       "event_id" AS "eventId",
       "requested_by" AS "requestedBy",
       "status",
       "storage_key" AS "storageKey",
       "error_message" AS "errorMessage",
       "included_count" AS "includedCount",
       "attempt_count" AS "attemptCount",
       "max_attempts" AS "maxAttempts",
       "last_attempt_at" AS "lastAttemptAt",
       "next_attempt_at" AS "nextAttemptAt",
       "locked_at" AS "lockedAt",
       "locked_until" AS "lockedUntil",
       "locked_by" AS "lockedBy",
       "created_at" AS "createdAt",
       "started_at" AS "startedAt",
       "completed_at" AS "completedAt",
       "updated_at" AS "updatedAt"`,
    now,
    lockedUntil,
    workerId,
    limit,
  );
}

function startAbstractBookHeartbeat(
  jobId: string,
  workerId: string,
  leaseMs: number,
  heartbeatMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const now = new Date();
    void prisma.abstractBookJob
      .updateMany({
        where: { id: jobId, status: AbstractBookJobStatus.RUNNING, lockedBy: workerId },
        data: { lockedUntil: new Date(now.getTime() + leaseMs) },
      })
      .catch((err) => {
        logger.warn({ err, jobId, workerId }, "Failed to extend Abstract Book job lease");
      });
  }, heartbeatMs);

  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export async function processAbstractBookJobs(
  limit = 1,
  options: ProcessAbstractBookJobsOptions = {},
) {
  const workerId = options.workerId ?? DEFAULT_WORKER_ID;
  const leaseMs = options.leaseMs ?? ABSTRACT_BOOK_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.min(ABSTRACT_BOOK_HEARTBEAT_MS, Math.max(1000, Math.floor(leaseMs / 2)));

  await recoverStaleAbstractBookJobs();
  const jobs = await claimAbstractBookJobs(limit, workerId, leaseMs);

  let processed = 0;
  for (const job of jobs) {
    const heartbeat = startAbstractBookHeartbeat(job.id, workerId, leaseMs, heartbeatMs);
    try {
      const { buffer, includedCount } = await generateAbstractBookPdf(job.eventId);
      const key = `${job.eventId}/abstracts/book/${job.id}.pdf`;
      const storageKey = await getStorageProvider().uploadPrivate(buffer, key, "application/pdf", {
        contentDisposition: `attachment; filename="abstract-book-${job.eventId}.pdf"`,
      });

      const completed = await prisma.abstractBookJob.updateMany({
        where: { id: job.id, status: AbstractBookJobStatus.RUNNING, lockedBy: workerId },
        data: {
          status: AbstractBookJobStatus.COMPLETED,
          storageKey,
          includedCount,
          completedAt: new Date(),
          errorMessage: null,
          nextAttemptAt: null,
          ...clearAbstractBookLeaseFields(),
        },
      });
      if (completed.count === 0) {
        logger.warn({ jobId: job.id, workerId }, "Abstract Book completion skipped because lease was lost");
      }
      processed += 1;
    } catch (err) {
      logger.error({ err, jobId: job.id, eventId: job.eventId }, "Abstract Book generation failed");
      const message = err instanceof Error ? err.message : "Unknown error";
      const shouldRetry = job.attemptCount < job.maxAttempts;
      const failed = await prisma.abstractBookJob.updateMany({
        where: { id: job.id, status: AbstractBookJobStatus.RUNNING, lockedBy: workerId },
        data: {
          status: shouldRetry ? AbstractBookJobStatus.PENDING : AbstractBookJobStatus.FAILED,
          errorMessage: message,
          completedAt: shouldRetry ? null : new Date(),
          nextAttemptAt: shouldRetry ? nextAbstractBookAttemptAt(job.attemptCount) : null,
          ...clearAbstractBookLeaseFields(),
        },
      });
      if (failed.count === 0) {
        logger.warn({ jobId: job.id, workerId }, "Abstract Book failure update skipped because lease was lost");
      }
      processed += 1;
    } finally {
      clearInterval(heartbeat);
    }
  }

  return { processed };
}

export async function getAbstractBookQueueHealth() {
  const now = new Date();
  const [pendingCount, duePendingCount, runningCount, staleRunningCount, failedCount, oldestPending] = await Promise.all([
    prisma.abstractBookJob.count({ where: { status: AbstractBookJobStatus.PENDING } }),
    prisma.abstractBookJob.count({
      where: {
        status: AbstractBookJobStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
    }),
    prisma.abstractBookJob.count({ where: { status: AbstractBookJobStatus.RUNNING } }),
    prisma.abstractBookJob.count({
      where: {
        status: AbstractBookJobStatus.RUNNING,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    }),
    prisma.abstractBookJob.count({ where: { status: AbstractBookJobStatus.FAILED } }),
    prisma.abstractBookJob.findFirst({
      where: { status: AbstractBookJobStatus.PENDING },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const oldestPendingAgeMs = oldestPending?.createdAt
    ? now.getTime() - oldestPending.createdAt.getTime()
    : 0;
  const isHealthy =
    staleRunningCount === 0 &&
    pendingCount < ABSTRACT_BOOK_PENDING_UNHEALTHY_SIZE &&
    oldestPendingAgeMs < ABSTRACT_BOOK_PENDING_UNHEALTHY_AGE_MS;

  return {
    pendingCount,
    duePendingCount,
    runningCount,
    staleRunningCount,
    failedCount,
    oldestPendingAgeMs,
    isHealthy,
  };
}

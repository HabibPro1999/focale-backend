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

const FINAL_STATUSES = [
  AbstractStatus.ACCEPTED,
  AbstractStatus.REJECTED,
  AbstractStatus.PENDING,
];

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const CONTENT_WIDTH = A4[0] - MARGIN * 2;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

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
      .map(([label, value]) => ({ label: String(label), text: typeof value === "string" ? value.trim() : "" }))
      .filter((section) => section.text.length > 0);
  }
  const body = typeof record.body === "string" ? record.body.trim() : "";
  return body ? [{ label: "Abstract", text: body }] : [];
}

function getAuthorLine(abstract: BookAbstract): string {
  const names = [`${abstract.authorFirstName} ${abstract.authorLastName}`.trim()];
  if (Array.isArray(abstract.coAuthors)) {
    for (const coAuthor of abstract.coAuthors) {
      if (!coAuthor || typeof coAuthor !== "object" || Array.isArray(coAuthor)) continue;
      const record = coAuthor as Record<string, unknown>;
      const firstName = typeof record.firstName === "string" ? record.firstName : "";
      const lastName = typeof record.lastName === "string" ? record.lastName : "";
      const fullName = `${firstName} ${lastName}`.trim();
      if (fullName) names.push(fullName);
    }
  }
  return names.filter(Boolean).join(", ");
}

function typeLabel(value: string | null): string {
  if (value === "ORAL_COMMUNICATION") return "Oral Communication";
  if (value === "POSTER") return "Poster";
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
      const themeA = themeLabel(a).toLocaleLowerCase();
      const themeB = themeLabel(b).toLocaleLowerCase();
      if (themeA !== themeB) return themeA.localeCompare(themeB);
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

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.split(/\r?\n/);
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
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.addPage();
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
    const lines = wrapText(text, font, size, CONTENT_WIDTH);
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

  writer.text(event.name, { bold: true, size: 22, gapAfter: 8 });
  writer.text("Abstract Book", { bold: true, size: 16, gapAfter: 20, color: rgb(0.25, 0.25, 0.25) });

  if (abstracts.length === 0) {
    writer.text("No accepted abstracts are available for this book.", { gapAfter: 10 });
  }

  abstracts.forEach((abstract, index) => {
    if (index > 0) writer.move(8);
    writer.ensure(120);
    writer.text(`${abstract.code ?? "No code"} — ${getContentTitle(abstract.content)}`, {
      bold: true,
      size: config.bookFontSize + 2,
      gapAfter: 6,
    });
    if (config.bookIncludeAuthorNames) {
      writer.text(getAuthorLine(abstract), { bold: true, gapAfter: 4 });
    }
    writer.text(`Type: ${typeLabel(abstract.finalType)}${themeLabel(abstract) ? ` · Themes: ${themeLabel(abstract)}` : ""}`, {
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

export async function processAbstractBookJobs(limit = 1) {
  const jobs = await prisma.abstractBookJob.findMany({
    where: { status: AbstractBookJobStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let processed = 0;
  for (const job of jobs) {
    const claimed = await prisma.abstractBookJob.updateMany({
      where: { id: job.id, status: AbstractBookJobStatus.PENDING },
      data: { status: AbstractBookJobStatus.RUNNING, startedAt: new Date(), errorMessage: null },
    });
    if (claimed.count === 0) continue;

    try {
      const { buffer, includedCount } = await generateAbstractBookPdf(job.eventId);
      const key = `${job.eventId}/abstracts/book/${job.id}.pdf`;
      const storageKey = await getStorageProvider().uploadPrivate(buffer, key, "application/pdf", {
        contentDisposition: `attachment; filename="abstract-book-${job.eventId}.pdf"`,
      });

      await prisma.abstractBookJob.update({
        where: { id: job.id },
        data: {
          status: AbstractBookJobStatus.COMPLETED,
          storageKey,
          includedCount,
          completedAt: new Date(),
        },
      });
      processed += 1;
    } catch (err) {
      logger.error({ err, jobId: job.id, eventId: job.eventId }, "Abstract Book generation failed");
      await prisma.abstractBookJob.update({
        where: { id: job.id },
        data: {
          status: AbstractBookJobStatus.FAILED,
          errorMessage: err instanceof Error ? err.message : "Unknown error",
          completedAt: new Date(),
        },
      });
      processed += 1;
    }
  }

  return { processed };
}

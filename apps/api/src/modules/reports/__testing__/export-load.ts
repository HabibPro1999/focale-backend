// 3.7 export load run, in a child process (registrations-export.perf.test.ts
// compiles it with tsc and runs it on plain node, NODE_ENV=production): the
// modular workbook for EXPORT_LOAD_ROWS (default 10,000) registrations x 60
// columns, rows generated page by page as the keyset iterator returns them,
// written into a discarding sink, optionally throttled like a slow client.
//
//   node --expose-gc <compiled>/export-load.js <streamed|legacy> [bytesPerSecond]
//
// Prints one JSON line: bytes, elapsed, baseline/peak RSS and heap, event-loop
// delay (max, p99). Test-only (excluded from the build).
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import type { ExportRegistrationsBody } from "@app/contracts";
import type { ModularRegistrationRow, RegistrationTableColumns } from "@app/db";
import { resolveExportColumns, writeRegistrationsWorkbook } from "../registrations-export-builder";
import { legacyBuildRegistrationsWorkbook } from "./legacy-registrations-workbook";

const ROWS = Number(process.env.EXPORT_LOAD_ROWS ?? 10_000);
const PAGE = 500;

const accessItems = Array.from({ length: 10 }, (_, i) => ({
  id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
  name: `Accès ${i}`,
}));

const tableColumns: RegistrationTableColumns = {
  fixedColumns: [],
  formColumns: Array.from({ length: 14 }, (_, i) => ({
    id: `q${i}`,
    label: `Question ${i}`,
    type: i % 3 === 0 ? "dropdown" : i % 3 === 1 ? "textarea" : "text",
    options:
      i % 3 === 0
        ? [
            { id: "a", label: "Option A" },
            { id: "b", label: "Option B" },
          ]
        : undefined,
  })),
};

// 8 identity + 5 submission + 12 payment + 2 sponsorship + 10 access +
// dropped + 2 global check-in + 5 per-access check-ins + transactions + 14
// form questions = 60 columns. (No lab-detail columns: they query the db.)
const body: ExportRegistrationsBody = {
  filters: {},
  language: "fr",
  columns: {
    identity: ["id", "referenceNumber", "email", "firstName", "lastName", "phone", "role", "note"],
    submission: ["submittedAt", "createdAt", "updatedAt", "lastEditedAt", "formSchemaVersion"],
    payment: [
      "paymentStatus",
      "paymentMethod",
      "currency",
      "totalAmount",
      "paidAmount",
      "baseAmount",
      "accessAmount",
      "discountAmount",
      "sponsorshipAmount",
      "paymentReference",
      "paymentProofUrl",
      "paidAt",
    ],
    sponsorship: ["sponsorshipCode", "labName"],
    accessItemIds: accessItems.map((a) => a.id),
    checkinAccessIds: accessItems.slice(0, 5).map((a) => a.id),
    includeGlobalCheckin: true,
    includeTransactions: true,
    includeDroppedAccess: true,
    formFieldIds: tableColumns.formColumns.map((c) => c.id),
  },
};

function registration(n: number): ModularRegistrationRow {
  const at = new Date(Date.UTC(2026, 8, 1) - n * 60_000);
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    formId: "form",
    eventId: "event",
    formData: Object.fromEntries(
      tableColumns.formColumns.map((c, i) => [
        c.id,
        c.type === "dropdown" ? (n % 2 ? "a" : "b") : `Réponse ${i} du participant ${n} — texte libre`,
      ]),
    ),
    networkingOptIn: null,
    submittedAt: at,
    formSchemaVersion: 1,
    email: `participant.${n}@example.test`,
    firstName: `Prénom${n}`,
    lastName: `Nom${n}`,
    phone: `+216 20 ${String(n).padStart(6, "0")}`,
    referenceNumber: `CONG-${n}`,
    paymentStatus: n % 3 ? "PAID" : "PENDING",
    totalAmount: 450_000,
    paidAmount: n % 3 ? 450_000 : 0,
    currency: "TND",
    paymentMethod: "BANK_TRANSFER",
    paymentReference: `VIR-${n}`,
    paymentProofUrl: `https://files.example.test/proofs/${n}.pdf`,
    priceBreakdown: {} as never,
    baseAmount: 400_000,
    discountAmount: 0,
    accessAmount: 50_000,
    sponsorshipCode: n % 5 === 0 ? `LAB-${n % 50}` : null,
    sponsorshipAmount: 0,
    labName: n % 5 === 0 ? "Lab" : null,
    paidAt: n % 3 ? at : null,
    createdAt: at,
    updatedAt: at,
    lastEditedAt: null,
    editToken: null,
    linkBaseUrl: null,
    idempotencyKey: null,
    note: n % 7 === 0 ? "Note de l'administrateur" : null,
    role: "PARTICIPANT",
    accessTypeIds: accessItems.filter((_, i) => (n + i) % 2 === 0).map((a) => a.id),
    droppedAccessIds: n % 11 === 0 ? [accessItems[0]!.id] : [],
    checkedInAt: n % 2 ? at : null,
    checkedInBy: n % 2 ? "Accueil" : null,
    accessCheckIns: [{ accessId: accessItems[0]!.id, checkedInAt: at }],
    transactions: [
      {
        type: "PAYMENT",
        amount: 450_000,
        method: "BANK_TRANSFER",
        reference: `VIR-${n}`,
        note: null,
        performedBy: "admin@example.test",
        createdAt: at,
      },
    ],
  };
}

async function* pages(): AsyncGenerator<ModularRegistrationRow[]> {
  for (let start = 0; start < ROWS; start += PAGE) {
    yield Array.from({ length: Math.min(PAGE, ROWS - start) }, (_, i) => registration(start + i));
  }
}

/** Discards bytes, optionally at a bounded rate (a slow client). */
function sink(bytesPerSecond?: number): Writable & { bytes: number } {
  const target = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      target.bytes += chunk.length;
      if (!bytesPerSecond) return callback();
      setTimeout(callback, (chunk.length / bytesPerSecond) * 1000);
    },
  }) as Writable & { bytes: number };
  target.bytes = 0;
  return target;
}

export async function measure(run: () => Promise<number>) {
  // Baseline once the module graph is loaded and collected: what the export adds.
  (globalThis as { gc?: () => void }).gc?.();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let peakExternal = baseline.external;
  // Event-loop delay two ways: the perf_hooks histogram, and a 10 ms timer's
  // lateness (which also sees one long synchronous block).
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let maxLagMs = 0;
  let expected = performance.now() + 10;
  const sampler = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - expected);
    expected = now + 10;
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakExternal = Math.max(peakExternal, usage.external);
  }, 10);
  histogram.enable();
  const started = performance.now();
  const bytes = await run();
  const elapsedMs = performance.now() - started;
  histogram.disable();
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  const mb = (n: number) => Math.round(n / 2 ** 20);
  return {
    rows: ROWS,
    columns: 60,
    bytes,
    elapsedMs: Math.round(elapsedMs),
    baselineRssMb: mb(baseline.rss),
    peakRssMb: mb(peakRss),
    exportRssMb: mb(peakRss - baseline.rss),
    baselineHeapMb: mb(baseline.heapUsed),
    peakHeapMb: mb(peakHeap),
    peakExternalMb: mb(peakExternal),
    maxDelayMs: Math.round(Math.max(histogram.max / 1e6, maxLagMs)),
    p99DelayMs: Math.round(histogram.percentile(99) / 1e6),
  };
}

async function streamed(bytesPerSecond?: number): Promise<number> {
  const out = new PassThrough({ highWaterMark: 1024 * 1024 });
  const target = sink(bytesPerSecond);
  out.pipe(target);
  const finished = new Promise((resolve) => target.on("finish", resolve));
  await writeRegistrationsWorkbook(out, new AbortController().signal, {
    eventId: "event",
    body,
    columns: resolveExportColumns(body, accessItems, tableColumns.formColumns),
    accessItems,
    pages: pages(),
  });
  await finished;
  return target.bytes;
}

async function legacy(): Promise<number> {
  const all: ModularRegistrationRow[] = [];
  for await (const page of pages()) all.push(...page);
  const result = await legacyBuildRegistrationsWorkbook(body, {
    event: { slug: "perf", name: "Perf" },
    tableColumns,
    accessItems,
    registrations: all,
    labDetails: [],
  });
  return result.data.length;
}

async function main() {
  const [mode = "streamed", rate] = process.argv.slice(2);
  const bytesPerSecond = rate ? Number(rate) : undefined;
  const result = await measure(() => (mode === "legacy" ? legacy() : streamed(bytesPerSecond)));
  process.stdout.write(`${JSON.stringify({ mode, bytesPerSecond: bytesPerSecond ?? null, ...result })}\n`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

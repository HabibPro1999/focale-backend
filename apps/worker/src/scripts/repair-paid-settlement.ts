/* eslint no-console: "off" */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  PaidRepairManifestError,
  applyPaidRepairRow,
  buildPaidRepairManifest,
  checkSettlementInvariants,
  closeDb,
  configureDb,
  parsePaidRepairManifest,
  planPaidSettlementRepair,
  type PaidRepairCandidate,
  type PaidRepairReport,
  type SettlementInvariantReport,
} from "@app/db";

// PAID data repair (plan 2.4). Never run it by hand against production
// without the sign-off below; it reads DATABASE_URL from the environment.
//
// Operator steps (also in README-rebuild.md, "Ops scripts"):
// 1. Dry run (read-only):
//      repair-paid-settlement --since <Nest deploy, ISO> [--event <id>] [--out repair-manifest.json]
//    prints the report — A: PAID with paid < net; B1: admin-edit demotions;
//    B2: self-edit demotions (status history rebuilt from the audit log);
//    B3: admin-created rows re-priced since --since (manual review);
//    C: seats each action would move, per access item — and writes the
//    manifest: one row per candidate, `action` null.
// 2. Sign-off: the approver copies the manifest (approved.json) and sets
//    `action` on every row: BACKFILL_PAID | CONVERT_PARTIAL (A rows),
//    REPROMOTE_PAID (B rows) or SKIP; a row can also be removed. Rows
//    without a proposal need a per-row decision.
// 3. Apply: repair-paid-settlement --apply --manifest approved.json
//    validates the whole manifest first (an unset action, or one not
//    allowed for its section, refuses it all), then executes exactly the
//    approved actions, each in its own locking transaction through the
//    settlement writer: a row that changed since the dry run (status, paid
//    amount, updated_at) or no longer fits its section is skipped and
//    reported; seats move only by the writer's delta; re-promotions that
//    find an access item full are skipped. Each change is audited
//    DATA_REPAIR_SETTLEMENT and enqueues registration.updated; no email.
//    Running the same manifest again changes nothing.
// 4. Check: repair-paid-settlement invariants [--event <id>] [--json]
//    runs the settlement invariant SQL checks (exit 2 when any fails).

type Mode = "dry-run" | "apply" | "invariants";

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @app/worker repair-paid-settlement --since <ISO date> [--event <id>] [--out <file>] [--json]",
    "  pnpm --filter @app/worker repair-paid-settlement --apply --manifest <approved.json>",
    "  pnpm --filter @app/worker repair-paid-settlement invariants [--event <id>] [--json] [--limit <n>]",
    "  (image: node apps/worker/dist/scripts/repair-paid-settlement.js ...)",
    "",
    "Dry run by default: prints the report and writes the manifest (default repair-manifest.json,",
    "never overwritten). --apply executes the approved manifest's actions only.",
    "invariants exits 2 when a check finds offending rows.",
  ].join("\n");
}

function describeCandidate(candidate: PaidRepairCandidate): string {
  const deltas = Object.entries(candidate.seatDelta).map(([action, delta]) => {
    const moves = Object.entries(delta ?? {}).map(([id, n]) => `${id}:${n > 0 ? "+" : ""}${n}`);
    return `${action}=${moves.length > 0 ? moves.join(",") : "-"}`;
  });
  return [
    `  registration=${candidate.id}`,
    `ref=${candidate.referenceNumber ?? "-"}`,
    `event=${candidate.eventId}`,
    `status=${candidate.expected.paymentStatus}`,
    `paid=${candidate.expected.paidAmount}`,
    `net=${candidate.net}`,
    `proposed=${candidate.proposedAction ?? "DECIDE"}`,
    ...(candidate.flags.length > 0 ? [`flags=${candidate.flags.join(",")}`] : []),
    `seats=${deltas.length > 0 ? deltas.join(";") : "-"}`,
    `detail=${JSON.stringify(candidate.detail)}`,
  ].join(" ");
}

function printReport(report: PaidRepairReport): void {
  const bySection = (section: string) => report.candidates.filter((c) => c.section === section);
  console.log(
    `Dry run since ${report.since}${report.eventId ? ` (event ${report.eventId})` : ""}: ` +
      `${report.candidates.length} candidate(s).`,
  );
  const titles: Array<[string, string]> = [
    ["A", "PAID with paid_amount < net"],
    ["B1", "admin-edit demotions"],
    ["B2", "self-edit demotions (status history rebuilt)"],
    ["B3", "admin-created rows re-priced since --since (manual review)"],
  ];
  for (const [section, title] of titles) {
    const rows = bySection(section);
    console.log(`${section}: ${title}: ${rows.length}`);
    for (const candidate of rows) console.log(describeCandidate(candidate));
  }
  console.log(`C: seat impact of the proposed actions: ${report.seatImpact.length} access item(s)`);
  for (const item of report.seatImpact) {
    console.log(
      [
        `  access=${item.accessId}`,
        `name=${JSON.stringify(item.name)}`,
        `paid=${item.paidCount ?? "?"}`,
        `capacity=${item.maxCapacity ?? "unlimited"}`,
        `delta=${item.proposedDelta > 0 ? "+" : ""}${item.proposedDelta}`,
        ...(item.overCapacity ? ["OVER_CAPACITY"] : []),
        `registrations=${item.registrationIds.join(",")}`,
      ].join(" "),
    );
  }
  const converts = report.candidates.filter((c) => c.seatDelta.CONVERT_PARTIAL !== undefined).length;
  if (converts > 0) {
    console.log("Note: rows converted to PARTIAL release their uncovered seats and then follow the PARTIAL capacity rules.");
  }
}

function printInvariants(report: SettlementInvariantReport): void {
  console.log(`Settlement invariants${report.eventId ? ` (event ${report.eventId})` : ""}: ${report.ok ? "OK" : "FAILED"}`);
  for (const check of report.checks) {
    console.log(`${check.name}: ${check.violations} (${check.description})`);
    for (const sample of check.samples) console.log(`  ${JSON.stringify(sample)}`);
    if (check.samples.length < check.violations) console.log(`  … ${check.violations - check.samples.length} more`);
  }
}

async function apply(manifestPath: string): Promise<void> {
  // Validate everything before any database access.
  const manifest = parsePaidRepairManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  configureDb({ applicationName: "focale-repair-paid-settlement" });
  console.log(`Apply ${manifest.rows.length} approved row(s) from ${manifestPath} (since ${manifest.since.toISOString()}).`);
  const counts = { applied: 0, skippedByApprover: 0, skipped: 0 };
  for (const row of manifest.rows) {
    const result = await applyPaidRepairRow(row, { since: manifest.since });
    if (result.outcome === "applied") {
      counts.applied += 1;
      const seats = [
        ...result.seatsMoved.incremented.map((id) => `${id}:+`),
        ...result.seatsMoved.decremented.map((id) => `${id}:-`),
      ];
      console.log(
        [
          "applied",
          `registration=${result.id}`,
          `action=${result.action}`,
          `status=${result.before.paymentStatus}->${result.after.paymentStatus}`,
          `paid=${result.before.paidAmount}->${result.after.paidAmount}`,
          `paidAt=${result.before.paidAt ?? "-"}->${result.after.paidAt ?? "-"}`,
          `seats=${seats.length > 0 ? seats.join(",") : "-"}`,
        ].join(" "),
      );
    } else if (result.reason === "SKIP") {
      counts.skippedByApprover += 1;
      console.log(`skip registration=${result.id} (approved SKIP)`);
    } else {
      counts.skipped += 1;
      console.log(
        `skipped registration=${result.id} action=${result.action} reason=${result.reason} detail=${JSON.stringify(result.detail)}`,
      );
    }
  }
  console.log(
    `Applied ${counts.applied}, skipped ${counts.skipped} (changed or not applicable), ` +
      `${counts.skippedByApprover} approved SKIP.`,
  );
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      since: { type: "string" },
      event: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
      manifest: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "invariants")) {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }
  const mode: Mode = positionals[0] === "invariants" ? "invariants" : values.apply ? "apply" : "dry-run";

  if (mode === "apply") {
    if (!values.manifest) throw new Error("--apply needs --manifest <approved.json>");
    if (values.since || values.event || values.out || values.json || values.limit) {
      throw new Error("--apply takes only --manifest: the manifest carries --since and the rows");
    }
    try {
      await apply(values.manifest);
    } finally {
      await closeDb();
    }
    return 0;
  }

  if (mode === "invariants") {
    if (values.since || values.out || values.manifest || values.apply) {
      throw new Error("invariants takes only --event, --json and --limit");
    }
    const sampleLimit = values.limit === undefined ? undefined : Number(values.limit);
    if (sampleLimit !== undefined && (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0)) {
      throw new Error("--limit must be a non-negative integer");
    }
    configureDb({ applicationName: "focale-settlement-invariants" });
    try {
      const report = await checkSettlementInvariants({ eventId: values.event, sampleLimit });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else printInvariants(report);
      return report.ok ? 0 : 2;
    } finally {
      await closeDb();
    }
  }

  if (values.manifest || values.limit) throw new Error("--manifest needs --apply; --limit is for invariants");
  if (!values.since) throw new Error("--since <Nest deploy date, ISO 8601> is required");
  const since = new Date(values.since);
  if (Number.isNaN(since.getTime())) throw new Error(`--since is not a date: ${values.since}`);
  const out = values.out ?? "repair-manifest.json";
  if (existsSync(out)) throw new Error(`${out} already exists: pass --out <new file> (a manifest is never overwritten)`);
  configureDb({ applicationName: "focale-repair-paid-settlement" });
  try {
    const report = await planPaidSettlementRepair({ since, eventId: values.event });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    // "wx": never overwrite a manifest someone may be reviewing.
    writeFileSync(out, `${JSON.stringify(buildPaidRepairManifest(report), null, 2)}\n`, { flag: "wx" });
    if (!values.json) {
      console.log(`Wrote ${out} (${report.candidates.length} row(s), every action unset). No rows changed.`);
    }
  } finally {
    await closeDb();
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof PaidRepairManifestError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exit(1);
  });

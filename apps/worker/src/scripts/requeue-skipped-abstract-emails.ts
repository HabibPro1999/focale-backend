import {
  enqueueAbstractEmailOutboxEvent,
  findSkippedAbstractEmails,
  withTxn,
  type AbstractEmailTrigger,
  type SkippedAbstractEmailRow,
} from "@app/db";

// Legacy parity: src/scripts/requeue-skipped-abstract-emails.ts.
// Re-enqueues abstract emails that were SKIPPED. Defaults to a dry run.

const ABSTRACT_EMAIL_TRIGGERS = [
  "ABSTRACT_SUBMISSION_ACK",
  "ABSTRACT_EDIT_ACK",
  "ABSTRACT_DECISION",
  "ABSTRACT_ACCEPTED",
  "ABSTRACT_REJECTED",
  "ABSTRACT_COMMITTEE_INVITE",
  "ABSTRACT_COMMITTEE_COMMENTS",
  "ABSTRACT_SCORE_DIVERGENCE",
  "ABSTRACT_FINAL_FILE_REQUEST",
] as const satisfies readonly AbstractEmailTrigger[];

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseLimit(): number {
  const raw = readArg("--limit");
  if (!raw) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be an integer from 1 to 500");
  }
  return limit;
}

function parseTrigger(): AbstractEmailTrigger | undefined {
  const raw = readArg("--trigger");
  if (!raw) return undefined;
  if (!ABSTRACT_EMAIL_TRIGGERS.includes(raw as AbstractEmailTrigger)) {
    throw new Error(
      `--trigger must be one of: ${ABSTRACT_EMAIL_TRIGGERS.join(", ")}`,
    );
  }
  return raw as AbstractEmailTrigger;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @app/worker requeue-skipped-abstract-emails [--apply] [--event-id <id>] [--abstract-id <id>] [--trigger <trigger>] [--limit <n>]",
    "",
    "Defaults to dry-run. Add --apply to enqueue new abstract email rows.",
  ].join("\n");
}

function dedupe(rows: SkippedAbstractEmailRow[]): SkippedAbstractEmailRow[] {
  const seen = new Set<string>();
  const out: SkippedAbstractEmailRow[] = [];
  for (const row of rows) {
    const key = [
      row.abstractId,
      row.abstractTrigger,
      row.recipientEmail.toLowerCase(),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const apply = hasFlag("--apply");
  const eventId = readArg("--event-id") ?? undefined;
  const abstractId = readArg("--abstract-id") ?? undefined;
  const trigger = parseTrigger();
  const limit = parseLimit();

  const rows = await findSkippedAbstractEmails({
    eventId,
    abstractId,
    trigger,
    limit,
  });
  const candidates = dedupe(rows);

  console.log(
    `${apply ? "Requeue" : "Dry run"}: found ${rows.length} skipped rows, ${candidates.length} unique candidates.`,
  );

  for (const candidate of candidates) {
    console.log(
      [
        apply ? "enqueue" : "candidate",
        `emailLog=${candidate.id}`,
        `abstract=${candidate.abstractId}`,
        `trigger=${candidate.abstractTrigger}`,
        `recipient=${candidate.recipientEmail}`,
        `queuedAt=${candidate.queuedAt.toISOString()}`,
        `reason=${candidate.errorMessage ?? ""}`,
      ].join(" "),
    );

    if (!apply) continue;

    await withTxn((tx) =>
      enqueueAbstractEmailOutboxEvent(tx, {
        trigger: candidate.abstractTrigger,
        abstractId: candidate.abstractId,
        recipientOverride: {
          email: candidate.recipientEmail,
          name: candidate.recipientName ?? undefined,
        },
      }),
    );
  }

  if (!apply) {
    console.log("No rows enqueued. Re-run with --apply after deployment.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    console.error(usage());
    process.exit(1);
  });

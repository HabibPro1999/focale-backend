import { parseArgs } from "node:util";
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

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      "event-id": { type: "string" },
      "abstract-id": { type: "string" },
      trigger: { type: "string" },
      limit: { type: "string" },
    },
    // Unknown flags were silently ignored by the hand-rolled parser; keep that.
    strict: false,
  });
  return values as {
    help?: boolean;
    apply?: boolean;
    "event-id"?: string;
    "abstract-id"?: string;
    trigger?: string;
    limit?: string;
  };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be an integer from 1 to 500");
  }
  return limit;
}

function parseTrigger(raw: string | undefined): AbstractEmailTrigger | undefined {
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
  const args = parseCliArgs();
  if (args.help) {
    console.log(usage());
    return;
  }

  const apply = args.apply === true;
  const eventId = args["event-id"] ?? undefined;
  const abstractId = args["abstract-id"] ?? undefined;
  const trigger = parseTrigger(args.trigger);
  const limit = parseLimit(args.limit);

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

    // H6: dedupeKey derived from the original (SKIPPED) email_logs id, so
    // running --apply twice on the same candidate enqueues only one outbox
    // event — the outbox's own dedupe_key index rejects the second attempt —
    // and that event's id then becomes the email_logs-level idempotency key
    // (queueAbstractEmail), so a crash-redelivery of it can't double-send
    // either. A different historical row (different original id) still gets
    // its own event and still sends.
    await withTxn((tx) =>
      enqueueAbstractEmailOutboxEvent(
        tx,
        {
          trigger: candidate.abstractTrigger,
          abstractId: candidate.abstractId,
          recipientOverride: {
            email: candidate.recipientEmail,
            name: candidate.recipientName ?? undefined,
          },
        },
        `requeue-skipped-abstract-email:${candidate.id}`,
      ),
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

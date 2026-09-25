/* eslint no-console: "off" */
import { parseArgs } from "node:util";
import {
  closeDb,
  configureDb,
  findDeadLetteredOutboxEvents,
  requeueDeadLetteredOutboxEvents,
  type DeadLetteredOutboxEvent,
} from "@app/db";

// Requeue dead-lettered outbox rows (plan 3.5). Dry run by default: lists the
// rows it would requeue. --apply puts them back as new (PENDING, attempts
// reset, due now); the worker's outbox job picks them up. realtime.emit rows
// are never requeued (a stale UI event is useless; retention deletes them).
// Reads DATABASE_URL from the environment.

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @app/worker requeue-dead-letters [--apply] [--type <outbox type>] [--id <id>]... [--since <ISO time>] [--limit <n>]",
    "  (image: node apps/worker/dist/scripts/requeue-dead-letters.js ...)",
    "",
    "Dry run by default. --since keeps rows dead-lettered at or after that time.",
    "--limit defaults to 100 (1 to 1000); oldest dead letters first.",
  ].join("\n");
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  return limit;
}

function parseSince(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) throw new Error("--since must be an ISO date or time");
  return since;
}

function describeRow(action: string, row: DeadLetteredOutboxEvent): string {
  return [
    action,
    `id=${row.id}`,
    `type=${row.type}`,
    `aggregate=${row.aggregateType ?? "-"}/${row.aggregateId ?? "-"}`,
    `attempts=${row.attemptCount}/${row.maxAttempts}`,
    `deadLetteredAt=${row.deadLetteredAt.toISOString()}`,
    `error=${JSON.stringify(row.errorMessage ?? "")}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      apply: { type: "boolean" },
      type: { type: "string" },
      id: { type: "string", multiple: true },
      since: { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  const apply = values.apply === true;
  const filter = {
    ids: values.id,
    type: values.type,
    since: parseSince(values.since),
    limit: parseLimit(values.limit),
  };

  configureDb({ applicationName: "focale-requeue-dead-letters" });
  try {
    const rows = await findDeadLetteredOutboxEvents(filter);
    console.log(`${apply ? "Requeue" : "Dry run"}: ${rows.length} dead-lettered outbox row(s) match.`);
    for (const row of rows) console.log(describeRow(apply ? "requeue" : "candidate", row));
    if (!apply) {
      if (rows.length > 0) console.log("No rows changed. Re-run with --apply to requeue them.");
      return;
    }
    const requeued = await requeueDeadLetteredOutboxEvents(rows.map((row) => row.id));
    console.log(`Requeued ${requeued} of ${rows.length} row(s).`);
  } finally {
    await closeDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exit(1);
  });

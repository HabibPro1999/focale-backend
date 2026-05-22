import type { AbstractEmailTrigger } from "@/generated/prisma/client.js";

const ABSTRACT_EMAIL_TRIGGERS = [
  "ABSTRACT_SUBMISSION_ACK",
  "ABSTRACT_EDIT_ACK",
  "ABSTRACT_DECISION",
  "ABSTRACT_COMMITTEE_INVITE",
  "ABSTRACT_COMMITTEE_COMMENTS",
  "ABSTRACT_SCORE_DIVERGENCE",
  "ABSTRACT_FINAL_FILE_REQUEST",
] as const satisfies readonly AbstractEmailTrigger[];

let prismaClient: { $disconnect: () => Promise<void> } | null = null;

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
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
    "  bun src/scripts/requeue-skipped-abstract-emails.ts [--apply] [--event-id <id>] [--abstract-id <id>] [--trigger <trigger>] [--limit <n>]",
    "",
    "Defaults to dry-run. Add --apply to enqueue new abstract email rows.",
  ].join("\n");
}

type Candidate = {
  id: string;
  abstractId: string;
  abstractTrigger: AbstractEmailTrigger;
  recipientEmail: string;
  recipientName: string | null;
  errorMessage: string | null;
  queuedAt: Date;
};

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];

  for (const candidate of candidates) {
    const key = [
      candidate.abstractId,
      candidate.abstractTrigger,
      candidate.recipientEmail.toLowerCase(),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
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
  const [{ prisma }, { queueAbstractEmail }] = await Promise.all([
    import("@/database/client.js"),
    import("@modules/abstracts/abstracts.email-queue.js"),
  ]);
  prismaClient = prisma;

  const rows = await prisma.emailLog.findMany({
    where: {
      status: "SKIPPED",
      abstractId: abstractId ?? { not: null },
      abstractTrigger: trigger ?? { not: null },
      ...(eventId ? { abstract: { eventId } } : {}),
    },
    orderBy: { queuedAt: "desc" },
    take: limit,
    select: {
      id: true,
      abstractId: true,
      abstractTrigger: true,
      recipientEmail: true,
      recipientName: true,
      errorMessage: true,
      queuedAt: true,
    },
  });

  const candidates = dedupeCandidates(
    rows.flatMap((row): Candidate[] =>
      row.abstractId && row.abstractTrigger
        ? [
            {
              id: row.id,
              abstractId: row.abstractId,
              abstractTrigger: row.abstractTrigger,
              recipientEmail: row.recipientEmail,
              recipientName: row.recipientName,
              errorMessage: row.errorMessage,
              queuedAt: row.queuedAt,
            },
          ]
        : [],
    ),
  );

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

    await queueAbstractEmail({
      trigger: candidate.abstractTrigger,
      abstractId: candidate.abstractId,
      recipientOverride: {
        email: candidate.recipientEmail,
        name: candidate.recipientName,
      },
    });
  }

  if (!apply) {
    console.log("No rows enqueued. Re-run with --apply after deployment.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    console.error(usage());
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaClient?.$disconnect();
  });

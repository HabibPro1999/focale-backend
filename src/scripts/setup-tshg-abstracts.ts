import { prisma } from "@/database/client.js";

const THEMES = [
  "Genome Projects",
  "Genomics of rare diseases",
  "Genomics of complex diseases",
  "Oncogenomics",
] as const;

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function tunisDateTime(value: string): Date {
  return new Date(`${value}+01:00`);
}

async function main() {
  const eventId = readArg("--event-id");
  const slug = readArg("--slug");

  if (!eventId && !slug) {
    throw new Error("Usage: bun src/scripts/setup-tshg-abstracts.ts --event-id <id> OR --slug <slug>");
  }

  const event = await prisma.event.findFirst({
    where: eventId ? { id: eventId } : { slug: slug! },
    select: { id: true, slug: true, name: true },
  });

  if (!event) {
    throw new Error("Event not found");
  }

  const config = await prisma.abstractConfig.upsert({
    where: { eventId: event.id },
    create: {
      eventId: event.id,
      submissionMode: "FREE_TEXT",
      globalWordLimit: 300,
      submissionStartAt: tunisDateTime("2026-05-24T00:00:00"),
      submissionDeadline: tunisDateTime("2026-07-05T23:59:59"),
      editingEnabled: true,
      editingDeadline: tunisDateTime("2026-07-05T23:59:59"),
      scoringStartAt: tunisDateTime("2026-07-06T00:00:00"),
      scoringDeadline: tunisDateTime("2026-07-19T23:59:59"),
      commentsEnabled: false,
      commentsSentToAuthor: false,
      reviewersPerAbstract: 3,
      divergenceThreshold: 10,
      maxThemesPerAbstract: 1,
      bookOrder: "BY_THEME",
      bookFontFamily: "Times",
      bookFontSize: 9,
      bookLineSpacing: 1.15,
    },
    update: {
      submissionMode: "FREE_TEXT",
      globalWordLimit: 300,
      submissionStartAt: tunisDateTime("2026-05-24T00:00:00"),
      submissionDeadline: tunisDateTime("2026-07-05T23:59:59"),
      editingEnabled: true,
      editingDeadline: tunisDateTime("2026-07-05T23:59:59"),
      scoringStartAt: tunisDateTime("2026-07-06T00:00:00"),
      scoringDeadline: tunisDateTime("2026-07-19T23:59:59"),
      commentsEnabled: false,
      commentsSentToAuthor: false,
      reviewersPerAbstract: 3,
      divergenceThreshold: 10,
      maxThemesPerAbstract: 1,
      bookOrder: "BY_THEME",
      bookFontFamily: "Times",
      bookFontSize: 9,
      bookLineSpacing: 1.15,
    },
  });

  await prisma.abstractTheme.updateMany({
    where: { configId: config.id, label: { notIn: [...THEMES] } },
    data: { active: false },
  });

  for (const [index, label] of THEMES.entries()) {
    const existing = await prisma.abstractTheme.findFirst({
      where: { configId: config.id, label },
      select: { id: true },
    });
    if (existing) {
      await prisma.abstractTheme.update({
        where: { id: existing.id },
        data: { sortOrder: index + 1, active: true },
      });
    } else {
      await prisma.abstractTheme.create({
        data: { configId: config.id, label, sortOrder: index + 1, active: true },
      });
    }
  }

  console.log(`Configured TSHG abstract settings for ${event.name} (${event.slug}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

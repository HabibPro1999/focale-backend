import { prisma, getPool } from "@/database/client.js";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

let disconnected = false;

export { prisma };

export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  const tableList = tables.map(({ table_name }) => quoteIdentifier(table_name));
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList.join(", ")} CASCADE`);
}

export async function disconnectDatabase(): Promise<void> {
  if (disconnected) {
    return;
  }

  disconnected = true;
  await prisma.$disconnect();
  const pool = getPool();
  if (pool) {
    await pool.end();
  }
}

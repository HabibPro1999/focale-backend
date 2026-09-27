import type { Client } from "pg";

export async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS present`,
    [name],
  );
  return Boolean(result.rows[0]?.present);
}


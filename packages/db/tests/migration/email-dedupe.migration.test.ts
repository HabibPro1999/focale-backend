import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

describe.runIf(dbTestsEnabled())("migration tier: email dedupe index", () => {
  let scratch: ScratchDatabase;
  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "email_dedupe", to: "0003" });
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("creates the partial unique dedupe index scoped to active statuses", async () => {
    const { rows } = await scratch.client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_logs_dedupe_key_active_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
    expect(rows[0].indexdef).toContain("dedupe_key");
    expect(rows[0].indexdef).toMatch(/WHERE/i);
    expect(rows[0].indexdef).toContain("QUEUED");
  });

  it("rejects a duplicate active key while allowing a distinct key", async () => {
    const insert = (id: string, dedupeKey: string) =>
      scratch.client.query(
        `INSERT INTO email_logs
           (id, recipient_email, subject, status, dedupe_key, updated_at)
         VALUES ($1, 'a@x.com', 'S', 'QUEUED', $2, now())`,
        [id, dedupeKey],
      );

    await insert("log-a", "outbox:evt-1");
    await expect(insert("log-b", "outbox:evt-1")).rejects.toThrow(/duplicate key value/i);
    await insert("log-c", "outbox:evt-2");
    const { rows } = await scratch.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_logs WHERE dedupe_key LIKE 'outbox:%'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

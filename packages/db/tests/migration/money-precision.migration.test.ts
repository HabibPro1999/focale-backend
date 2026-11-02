import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, dbTestsEnabled, type ScratchDatabase } from "@app/db/testing";
import { dbTestSetupTimeoutMs } from "../../../vitest.shared";
import { DATA_CHECKS } from "../../src/ops/cutover-preflight-checks";

describe.runIf(dbTestsEnabled())("money precision migration preserves major units", () => {
  let scratch: ScratchDatabase;
  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "money_precision", to: "0035" });
    await scratch.client.query("INSERT INTO clients (id,name,updated_at) VALUES ('money-client','Test',now())");
    await scratch.client.query("INSERT INTO events (id,client_id,name,slug,start_date,end_date,updated_at) VALUES ('money-event','money-client','Test','money-test',now(),now(),now())");
    await scratch.client.query("INSERT INTO event_pricing (id,event_id,base_price,currency,updated_at) VALUES ('money-price','money-event',100,'TND',now())");
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("preserves 100 as 100 and stores fractional prices without truncation", async () => {
    const check = DATA_CHECKS.find((entry) => entry.migrationId === "0036")!;
    // This check uses only the client; migration/isolated are unused.
    const context = { client: scratch.client } as Parameters<typeof check.run>[0];
    expect(await check.run(context)).toMatchObject({ status: "no-change" });
    // Seed a legacy INT8 value that cannot fit DECIMAL(20,4).
    await scratch.client.query("INSERT INTO event_access (id,event_id,name,type,companion_price,updated_at) VALUES ('money-access','money-event','Test','WORKSHOP',10000000000000000,now())");
    expect(await check.run(context)).toMatchObject({ status: "fails", review: true });
    await scratch.client.query("UPDATE event_access SET companion_price=100 WHERE id='money-access'");
    expect((await scratch.applyMigrations({ to: "0036" })).applied).toEqual(["0036"]);
    expect((await scratch.client.query("SELECT base_price = 100 AS preserved FROM event_pricing WHERE id='money-price'")).rows).toEqual([{ preserved: true }]);
    await scratch.client.query("UPDATE event_pricing SET base_price=100.125 WHERE id='money-price'");
    expect((await scratch.client.query("SELECT base_price = 100.125 AS exact FROM event_pricing WHERE id='money-price'")).rows).toEqual([{ exact: true }]);
    expect((await scratch.applyMigrations({ to: "0036" })).applied).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listEvents } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedClient, seedEvent } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("event list client context", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("embeds only the owning client id/name while preserving filters and totals", async () => {
    const client = await seedClient({ name: "Event owner" });
    const other = await seedClient({ name: "Other owner" });
    const event = await seedEvent({ clientId: client.id });
    await seedEvent({ clientId: other.id });
    const page = await listEvents({ clientId: client.id, limit: 1, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ id: event.id, clientId: client.id, client: { id: client.id, name: client.name } });
    expect(Object.keys(page.data[0].client).sort()).toEqual(["id", "name"]);
  });
});

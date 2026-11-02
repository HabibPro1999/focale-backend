import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listClientsPage } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedClient, seedEvent, seedUser } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("client list dependency counts", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("counts all deletion-blocking dependencies without crossing clients", async () => {
    const client = await seedClient({ name: "Counted client" });
    const other = await seedClient({ name: "Other client" });
    await seedUser({ clientId: client.id });
    await seedUser({ clientId: client.id, active: false });
    await seedEvent({ clientId: client.id, status: "ARCHIVED" });
    await seedUser({ clientId: other.id });
    const page = await listClientsPage({ search: "Counted", offset: 0, limit: 1 });
    expect(page.total).toBe(1);
    expect(page.data).toEqual([expect.objectContaining({ id: client.id, userCount: 2, eventCount: 1 })]);
  });
  it("returns numeric zero for clients without dependencies", async () => {
    await seedClient({ name: "Empty" });
    const page = await listClientsPage({ offset: 0, limit: 10 });
    expect(page.data[0]).toMatchObject({ userCount: 0, eventCount: 0 });
  });
});

import { networkingStore, type DbExecutor, type NetworkingRow } from "@app/db";
import type { NetworkingConfig } from "@app/contracts";

/** The two-event auth suites share this seed; forms, participants and sessions stay suite-specific. */
export async function seedNetworkingEvents(db: DbExecutor, input: {
  clientId: string;
  eventIds: string[];
  name: string;
  config: NetworkingConfig;
}) {
  const events: NetworkingRow<"events">[] = [];
  for (const id of input.eventIds) {
    const row = await networkingStore(db).insert("events", {
      id, clientId: input.clientId, name: input.name, slug: id, status: "OPEN",
      startDate: new Date("2031-04-05T00:00Z"), endDate: new Date("2031-04-06T00:00Z"),
    });
    events.push(row);
    await networkingStore(db).insert("configs", { eventId: id, config: input.config });
  }
  return events;
}

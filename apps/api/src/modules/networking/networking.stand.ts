import { type NetworkingStore } from "@app/db";

export async function activeStand(store: NetworkingStore, eventId: string, standTableId: string) {
  const stand = await store.one("tables", { eventId, id: standTableId, kind: "STAND" });
  const space = stand?.spaceId ? await store.one("spaces", { eventId, id: stand.spaceId }) : null;
  // A missing space intentionally remains allowed at these two call sites.
  return !stand?.active || space?.active === false ? null : { stand, space };
}

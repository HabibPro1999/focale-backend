import type { NetworkingStore } from "@app/db";

/** A missing space remains allowed; only an explicitly inactive space hides a stand. */
export async function activeNetworkingStand(store: NetworkingStore, eventId: string, standTableId: string) {
  const stand = await store.one("tables", { eventId, id: standTableId, kind: "STAND" });
  const space = stand?.spaceId ? await store.one("spaces", { eventId, id: stand.spaceId }) : null;
  return !stand?.active || space?.active === false ? null : { stand, space };
}

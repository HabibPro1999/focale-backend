import { NetworkingConfigSchema } from "@app/contracts";
import { type NetworkingStore } from "@app/db";

export async function loadNetworkingConfig(store: NetworkingStore, eventId: string) {
  return NetworkingConfigSchema.parse((await store.one("configs", { eventId }))?.config ?? {});
}

import type { ClientModuleGate } from "../client-module-gate";
import { eq } from "drizzle-orm";
import { type DbExecutor } from "../client";
import { sponsorships, sponsorshipBatches, sponsorshipUsages } from "../schema/sponsorships";

// Row types inferred from the drizzle schema.
export type SponsorshipRow = typeof sponsorships.$inferSelect;
export type SponsorshipUsageRow = typeof sponsorshipUsages.$inferSelect;
export type SponsorshipBatchRow = typeof sponsorshipBatches.$inferSelect;

// Client module-gate slice used by the service's assertModuleEnabledForClient.
export type SponsorshipClientGate = ClientModuleGate;

export function appendToGroup<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const values = groups.get(key) ?? [];
  values.push(value);
  groups.set(key, values);
}

export interface ExistingUsageRow {
  sponsorshipId: string;
  sponsorship: {
    code: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
  };
}

export async function loadExistingUsages(
  db: DbExecutor,
  registrationId: string,
): Promise<ExistingUsageRow[]> {
  const rows = await db
    .select({
      sponsorshipId: sponsorshipUsages.sponsorshipId,
      code: sponsorships.code,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
    })
    .from(sponsorshipUsages)
    .innerJoin(
      sponsorships,
      eq(sponsorshipUsages.sponsorshipId, sponsorships.id),
    )
    .where(eq(sponsorshipUsages.registrationId, registrationId));
  return rows.map((u) => ({
    sponsorshipId: u.sponsorshipId,
    sponsorship: {
      code: u.code,
      coversBasePrice: u.coversBasePrice,
      coveredAccessIds: u.coveredAccessIds ?? [],
    },
  }));
}


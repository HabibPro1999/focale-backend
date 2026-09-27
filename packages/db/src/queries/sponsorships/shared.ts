import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../client";
import { sponsorships, sponsorshipUsages } from "../../schema/sponsorships";
import type { sponsorshipBatches } from "../../schema/sponsorships";
import type { ClientModuleGate } from "../clients";

// Row types inferred from the drizzle schema.
export type SponsorshipRow = typeof sponsorships.$inferSelect;
export type SponsorshipUsageRow = typeof sponsorshipUsages.$inferSelect;
export type SponsorshipBatchRow = typeof sponsorshipBatches.$inferSelect;

// Client module-gate slice used by the service's assertModuleEnabledForClient.
export type SponsorshipClientGate = ClientModuleGate;

export function appendGrouped<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const list = groups.get(key) ?? [];
  list.push(value);
  groups.set(key, list);
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
      sponsorship: {
        code: sponsorships.code,
        coversBasePrice: sponsorships.coversBasePrice,
        coveredAccessIds: sponsorships.coveredAccessIds,
      },
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
      ...u.sponsorship,
      coveredAccessIds: u.sponsorship.coveredAccessIds ?? [],
    },
  }));
}

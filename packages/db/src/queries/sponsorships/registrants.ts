import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../../client";
import { ilikeContains } from "../../like";
import { sponsorships, sponsorshipUsages } from "../../schema/sponsorships";
import { events } from "../../schema/events-access";
import { registrations } from "../../schema/registrations";
import { appendGrouped } from "./shared";

// ============================================================================
// Registration projection used by the sponsorship route guard.
// ============================================================================

export interface RegistrationRouteGuard {
  id: string;
  event: { id: string; clientId: string };
}

export async function getRegistrationForSponsorship(
  registrationId: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationRouteGuard | null> {
  const [row] = await db
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      clientId: events.clientId,
    })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, event: { id: row.eventId, clientId: row.clientId } };
}

// ============================================================================
// Registrant search for sponsorship selection.
// ============================================================================

export interface RegistrantSearchRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  paymentStatus: string;
  totalAmount: number;
  baseAmount: number;
  accessAmount: number;
  sponsorshipAmount: number;
  accessTypeIds: string[];
  coveredAccessIds: string[];
  isBasePriceCovered: boolean;
}

/**
 * Registrants of an event for the anonymous sponsor form (its only caller):
 * reads no contact details (phone) or form answers.
 */
export async function searchRegistrantsForSponsorship(
  eventId: string,
  query: { query: string; unpaidOnly: boolean; limit: number },
  db: DbExecutor = getDb(),
): Promise<RegistrantSearchRow[]> {
  // The term is user input (anonymous on the sponsor form): match literally.
  const clauses: (SQL | undefined)[] = [
    eq(registrations.eventId, eventId),
    or(
      ilikeContains(registrations.email, query.query),
      ilikeContains(registrations.firstName, query.query),
      ilikeContains(registrations.lastName, query.query),
    ),
  ];
  if (query.unpaidOnly) {
    clauses.push(
      inArray(registrations.paymentStatus, ["PENDING", "VERIFYING", "PARTIAL"]),
    );
  }

  const regRows = await db
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      paymentStatus: registrations.paymentStatus,
      totalAmount: registrations.totalAmount,
      baseAmount: registrations.baseAmount,
      accessAmount: registrations.accessAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      accessTypeIds: registrations.accessTypeIds,
    })
    .from(registrations)
    .where(and(...clauses))
    .orderBy(asc(registrations.lastName), asc(registrations.firstName))
    .limit(query.limit);

  const regIds = regRows.map((r) => r.id);
  const usageRows = regIds.length
    ? await db
        .select({
          registrationId: sponsorshipUsages.registrationId,
          status: sponsorships.status,
          coversBasePrice: sponsorships.coversBasePrice,
          coveredAccessIds: sponsorships.coveredAccessIds,
        })
        .from(sponsorshipUsages)
        .innerJoin(
          sponsorships,
          eq(sponsorshipUsages.sponsorshipId, sponsorships.id),
        )
        .where(inArray(sponsorshipUsages.registrationId, regIds))
    : [];

  const usedByReg = new Map<
    string,
    Array<{ coversBasePrice: boolean; coveredAccessIds: string[] }>
  >();
  for (const u of usageRows) {
    if (u.status !== "USED" || !u.registrationId) continue;
    appendGrouped(usedByReg, u.registrationId, {
      coversBasePrice: u.coversBasePrice,
      coveredAccessIds: u.coveredAccessIds ?? [],
    });
  }

  return regRows.map((r) => {
    const used = usedByReg.get(r.id) ?? [];
    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      paymentStatus: r.paymentStatus,
      totalAmount: r.totalAmount,
      baseAmount: r.baseAmount,
      accessAmount: r.accessAmount,
      sponsorshipAmount: r.sponsorshipAmount,
      accessTypeIds: r.accessTypeIds ?? [],
      coveredAccessIds: [...new Set(used.flatMap((s) => s.coveredAccessIds))],
      isBasePriceCovered: used.some((s) => s.coversBasePrice),
    };
  });
}

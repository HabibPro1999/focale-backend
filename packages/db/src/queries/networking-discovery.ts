import { networkingPageLimit } from "./networking-pagination";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import type { NetworkingConfig } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import {
  networkingProfiles as profiles,
} from "../schema/networking";
import { registrations } from "../schema/registrations";
import { discoverableCounterpart, notInteracted } from "../policy/networking-eligibility";
import {
  normalizeNetworkingSearch,
  networkingSearchScore,
} from "./networking-search";
export interface NetworkingDiscoveryFilters {
  standTableId?: string;
  q?: string;
  sector?: string;
  sectors?: string[];
  company?: string;
  excludeInteracted?: boolean;
  city?: string;
  country?: string;
  sort?: string;
  page?: number;
  limit?: number;
}
const normalizedSql = (column: SQL | AnyColumn) =>
  sql`lower(translate(${column},'àáâäãåāăąèéêëēėęìíîïīįòóôöõøōùúûüūųçćčñńšśžźżýÿ','aaaaaaaaaeeeeeeeiiiiiiooooooouuuuuucccnnsszzzyy'))`;
function registrationLookup(db: DbExecutor) {
  // Bounded primary-key lookup avoids a quadratic tenant/date nested-loop plan for newly imported events with stale statistics.
  return db
    .select({
      eventId: registrations.eventId,
      paymentStatus: registrations.paymentStatus,
      networkingOptIn: registrations.networkingOptIn,
    })
    .from(registrations)
    .where(eq(registrations.id, profiles.registrationId))
    .limit(1)
    .as("source_registration");
}
function networkingDiscoveryWhere({ eventId, profileId, paymentStatuses, query = {}, registration }: {
  eventId: string;
  profileId: string;
  paymentStatuses: NetworkingConfig["eligiblePaymentStatuses"];
  query?: NetworkingDiscoveryFilters;
  registration: ReturnType<typeof registrationLookup>;
}) {
  return and(
    eq(profiles.eventId, eventId),
    query.standTableId ? eq(profiles.standTableId, query.standTableId) : undefined,
    // 4.6: the counterpart policy's discover mode (eligible, discoverable, distinct, unblocked).
    discoverableCounterpart(profiles, registration, paymentStatuses, { eventId, profileId }),
    query.excludeInteracted ? notInteracted(eventId, profileId, profiles.id) : undefined,
    query.company ? eq(profiles.company, query.company) : undefined,
    query.sector ? eq(profiles.sector, query.sector) : undefined,
    query.sectors?.length ? inArray(profiles.sector, query.sectors) : undefined,
    query.city
      ? eq(normalizedSql(profiles.city), normalizeNetworkingSearch(query.city))
      : undefined,
    query.country
      ? eq(
          normalizedSql(profiles.country),
          normalizeNetworkingSearch(query.country),
        )
      : undefined,
  );
}
/** No registration forms, private contact data or unrelated event rows are loaded for filtering. */
export async function listNetworkingDiscovery(
  eventId: string,
  profileId: string,
  paymentStatuses: NetworkingConfig["eligiblePaymentStatuses"],
  query: NetworkingDiscoveryFilters = {},
  db: DbExecutor = getDb(),
) {
  const registration = registrationLookup(db);
  const where = networkingDiscoveryWhere({ eventId, profileId, paymentStatuses, query, registration });
  const limit = networkingPageLimit(query.limit ?? 30),
    offset = (Math.max(1, query.page ?? 1) - 1) * limit;
  let selectedIds: string[] | undefined;
  if (query.q?.trim()) {
    // Portable fuzzy/phonetic matching uses only short searchable fields after all SQL eligibility filters.
    const candidates = await db
      .select({
        id: profiles.id,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        company: profiles.company,
        jobTitle: profiles.jobTitle,
        sector: profiles.sector,
      })
      .from(profiles)
      .innerJoinLateral(registration, sql`true`)
      .where(where);
    const scored = candidates
      .map((p) => ({
        id: p.id,
        score: networkingSearchScore(
          query.q!,
          `${p.firstName} ${p.lastName} ${p.company} ${p.jobTitle} ${p.sector}`,
        ),
      }))
      .filter(
        (value): value is { id: string; score: number } => value.score !== null,
      );
    if (query.sort === "recommended")
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    selectedIds = scored.map((value) => value.id);
    if (!selectedIds.length) return { items: [], total: 0 };
    if (query.sort === "recommended") {
      const pageIds = selectedIds.slice(offset, offset + limit);
      if (!pageIds.length) return { items: [], total: selectedIds.length };
      const items = await db
        .select(getTableColumns(profiles))
        .from(profiles)
        .innerJoinLateral(registration, sql`true`)
        .where(and(where, inArray(profiles.id, pageIds)));
      const positions = new Map(pageIds.map((id, index) => [id, index]));
      items.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
      return { items, total: selectedIds.length };
    }
  }
  const filtered = and(
    where,
    selectedIds
      ? sql`${profiles.id} = ANY(${sql.param(selectedIds)}::text[])`
      : undefined,
  );
  const ordering =
    query.sort === "recommended"
      ? [
          desc(profiles.featured),
          sql`${profiles.lastActiveAt} DESC NULLS LAST`,
          asc(profiles.id),
        ]
      : query.sort === "recent"
        ? [sql`${profiles.lastActiveAt} DESC NULLS LAST`, asc(profiles.id)]
        : query.sort === "company"
          ? [asc(profiles.company), asc(profiles.id)]
          : [asc(profiles.firstName), asc(profiles.lastName), asc(profiles.id)];
  const [rows, counts] = await Promise.all([
    db
      .select(getTableColumns(profiles))
      .from(profiles)
      .innerJoinLateral(registration, sql`true`)
      .where(filtered)
      .orderBy(...ordering)
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(profiles)
      .innerJoinLateral(registration, sql`true`)
      .where(filtered),
  ]);
  return { items: rows, total: counts[0]?.total ?? 0 };
}

export async function networkingDirectoryFacets(
  eventId: string,
  profileId: string,
  paymentStatuses: NetworkingConfig["eligiblePaymentStatuses"],
) {
  const db = getDb(),
    registration = registrationLookup(db),
    where = networkingDiscoveryWhere({ eventId, profileId, paymentStatuses, registration });
  const rows = await db
    .select({
      sector: profiles.sector,
      company: profiles.company,
      city: profiles.city,
      country: profiles.country,
    })
    .from(profiles)
    .innerJoinLateral(registration, sql`true`)
    .where(where);
  const facet = (key: keyof (typeof rows)[number]) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = row[key].trim();
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value));
  };
  return {
    sectors: facet("sector"),
    companies: facet("company"),
    cities: facet("city"),
    countries: facet("country"),
  };
}

/** Operator-only explain helper; no HTTP route exposes query plans. */
export async function explainNetworkingDiscovery(
  eventId: string,
  profileId: string,
  paymentStatuses: NetworkingConfig["eligiblePaymentStatuses"],
  query: NetworkingDiscoveryFilters = {},
) {
  const db = getDb(),
    registration = registrationLookup(db);
  const where = networkingDiscoveryWhere({ eventId, profileId, paymentStatuses, query, registration });
  const statement = db
    .select(getTableColumns(profiles))
    .from(profiles)
    .innerJoinLateral(registration, sql`true`)
    .where(where)
    .orderBy(asc(profiles.firstName), asc(profiles.lastName), asc(profiles.id))
    .limit(30);
  return db.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.getSQL()}`,
  );
}


import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PriceBreakdown } from "@app/contracts";
import { closeDb } from "@app/db";
import { dbTestsEnabled, type ScratchDatabase } from "@app/db/testing";
import { createMigratedLegacyDatabase, LEGACY_IDS } from "@app/db/testing/fixtures";
import { AccessService } from "./modules/access/access.service";
import { PricingService } from "./modules/pricing/pricing.service";
import { formatStoredJsonReport, loadStoredJsonReport } from "./scripts/stored-json-scan";

// API code on production data: a legacy Prisma database holding rows written
// the way main's writers write them (form schemas with conditions and
// translations, pricing rules and access conditions with the `in` operator,
// addon access items, certificate zones, email context snapshots in every
// legacy shape, price breakdowns of public signups, admin creates,
// sponsorship codes and access drops), adopted and migrated like production
// (createMigratedLegacyDatabase in packages/db/tests/helpers/legacy-data.ts).

const ids = LEGACY_IDS;
const ACCESS_NAMES = new Map<string, string>(Object.entries(ids.access).map(([name, id]) => [id, name]));
const REGISTRATION_NAMES = new Map<string, string>(Object.entries(ids.registration).map(([name, id]) => [id, name]));

describe.runIf(dbTestsEnabled())("API code on the migrated legacy production data", () => {
  let legacy: ScratchDatabase;
  let fileDatabaseUrl: string | undefined;

  beforeAll(async () => {
    ({ database: legacy } = await createMigratedLegacyDatabase({ label: "api_legacy_data" }));
    fileDatabaseUrl = process.env.DATABASE_URL;
    await closeDb();
    process.env.DATABASE_URL = legacy.url;
  });

  afterAll(async () => {
    await closeDb();
    if (fileDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = fileDatabaseUrl;
    await legacy?.close();
  });

  // The checklist keeps JSONB_VALIDATION=warn until this audit
  // (stored-json-report) is clean; on main's documents it is clean from the start.
  it("the stored-JSON audit finds no document JSONB_VALIDATION=enforce would refuse", async () => {
    const report = await loadStoredJsonReport({ batchSize: 4 });
    expect(report.columns.map((column) => [column.column, column.scanned, column.invalid, column.byCode])).toEqual([
      ["event_pricing.rules", 2, 0, {}],
      ["certificate_templates.zones", 3, 0, {}],
      ["forms.schema", 4, 0, {}],
      ["email_logs.context_snapshot", 17, 0, {}],
      ["registrations.price_breakdown", 17, 0, {}],
    ]);
    expect(formatStoredJsonReport(report).at(-1)).toBe(
      "Every typed JSON document matches its schema: JSONB_VALIDATION=enforce would refuse nothing. Nothing was changed.",
    );
  });

  it("prices each legacy registration again exactly as main stored it, `in` rules included", async () => {
    const pricing = new PricingService();
    const rows = await legacy.client.query<{ id: string; form_data: Record<string, unknown>; price_breakdown: PriceBreakdown }>(
      "SELECT id, form_data, price_breakdown FROM registrations WHERE event_id = $1 ORDER BY id",
      [ids.event.congress],
    );
    expect(rows.rows).toHaveLength(14);
    const priced = (pb: PriceBreakdown) => ({
      base: pb.calculatedBasePrice,
      rules: pb.appliedRules.map((rule) => rule.ruleId),
      lines: pb.accessItems.map((item) => [ACCESS_NAMES.get(item.accessId), item.quantity, item.subtotal]),
      subtotal: pb.subtotal,
    });
    for (const row of rows.rows) {
      const stored = row.price_breakdown;
      const fresh = await pricing.calculatePrice(ids.event.congress, {
        formData: row.form_data,
        selectedAccessItems: stored.accessItems.map((item) => ({ accessId: item.accessId, quantity: item.quantity })),
        sponsorshipCodes: [],
      });
      expect([REGISTRATION_NAMES.get(row.id), priced(fresh)]).toEqual([REGISTRATION_NAMES.get(row.id), priced(stored)]);
    }
    // The resident rule's `in` list matches its second value too.
    const intern = await pricing.calculatePrice(ids.event.congress, { formData: { specialty: "interne" }, selectedAccessItems: [], sponsorshipCodes: [] });
    expect(priced(intern)).toEqual({ base: 120, rules: [ids.rule.resident], lines: [], subtotal: 120 });
  });

  it("groups the legacy access items for the public form: `in` conditions, prerequisites and the addon group", async () => {
    const access = new AccessService();
    const view = async (formData: Record<string, unknown>, selected: string[]) => {
      const grouped = await access.getGroupedAccess(ids.event.congress, formData, selected);
      return {
        dated: grouped.groups.flatMap((group) => group.slots.map((slot) => slot.items.map((item) => ACCESS_NAMES.get(item.id)))),
        options: grouped.addonGroup?.slots.map((slot) => [slot.selectionType, slot.items.map((item) => ACCESS_NAMES.get(item.id))]),
      };
    };
    // The included plenary has its own slot; both nights (ADDON) share one.
    const options = [
      ["multiple", ["plenary"]],
      ["multiple", ["night1", "night2"]],
    ];
    // The workshop asks specialty `in` [cardiologue, resident]; it and the
    // dinner require the plenary (_AccessPrerequisites as main wrote it).
    expect(await view({ specialty: "resident" }, [ids.access.plenary])).toEqual({ dated: [["workshop"], ["dinner"]], options });
    expect(await view({ specialty: "autre" }, [ids.access.plenary])).toEqual({ dated: [["dinner"]], options });
    expect(await view({ specialty: "resident" }, [])).toEqual({ dated: [], options });
  });
});

import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DbExecutor } from "../client";
import { findPendingSponsorships } from "../queries/pricing";
import { claimSponsorshipCodeTxn, linkSponsorshipUsageTxn, type LinkableSponsorship } from "./sponsorship-code";

// Unit level: the real drizzle builders render the SQL; each awaited query
// resolves with the next queued result instead of touching a database. The
// locking and races are DB-tested in tests/db and the api concurrency suite.

const mockDb = drizzle.mock({ casing: "snake_case" });

type Query = { sql: string; params: unknown[] };

function fakeTx(results: unknown[][], opts: { transaction?: boolean } = {}) {
  const queries: Query[] = [];
  const answer = (query: { toSQL: () => Query }) => {
    (query as unknown as { execute: () => Promise<unknown> }).execute = async () => {
      queries.push(query.toSQL());
      return results.shift() ?? [];
    };
    return query;
  };
  const tx = {
    ...(opts.transaction === false ? {} : { rollback: () => undefined }),
    select: (fields?: never) => {
      const builder = fields ? mockDb.select(fields) : mockDb.select();
      const from = builder.from.bind(builder);
      builder.from = ((table: never) => answer(from(table) as never)) as typeof builder.from;
      return builder;
    },
    insert: (table: never) => {
      const builder = mockDb.insert(table);
      const values = builder.values.bind(builder);
      builder.values = ((v: never) => answer(values(v) as never)) as typeof builder.values;
      return builder;
    },
    update: (table: never) => {
      const builder = mockDb.update(table);
      const set = builder.set.bind(builder);
      builder.set = ((v: never) => answer(set(v) as never)) as typeof builder.set;
      return builder;
    },
  };
  return { tx: tx as unknown as DbExecutor, queries };
}

const sponsorshipRow = (over: Partial<LinkableSponsorship> = {}) => ({
  id: "sp1",
  eventId: "ev1",
  code: "SP-ABCD2345",
  status: "PENDING",
  targetRegistrationId: null,
  totalAmount: 300,
  coversBasePrice: true,
  coveredAccessIds: ["gala"],
  ...over,
});

describe("claimSponsorshipCodeTxn", () => {
  it("locks the event's code FOR UPDATE, then finds it available", async () => {
    const { tx, queries } = fakeTx([[{ id: "sp1" }], [sponsorshipRow()], [{ value: 0 }], []]);
    const claim = await claimSponsorshipCodeTxn(tx, "ev1", "SP-ABCD2345");

    expect(claim).toEqual({ outcome: "available", sponsorship: sponsorshipRow() });
    expect(queries[0].sql).toMatch(/from "sponsorships" where \("sponsorships"\."event_id" = \$1 and "sponsorships"\."code" = \$2\).* for update$/);
    expect(queries[0].params).toEqual(["ev1", "SP-ABCD2345", 1]);
    // A claim made before codes were consumed matches the stored code trimmed and upper-cased.
    expect(queries[3].sql).toContain(`upper(trim("registrations"."sponsorship_code")) = $`);
  });

  it.each([
    ["the event has no such code", [[]]],
    ["the code was cancelled", [[{ id: "sp1" }], [sponsorshipRow({ status: "CANCELLED" })]]],
  ])("is invalid when %s", async (_, results) => {
    const { tx } = fakeTx(results as unknown[][]);
    expect(await claimSponsorshipCodeTxn(tx, "ev1", "SP-ABCD2345")).toEqual({ outcome: "invalid" });
  });

  it.each([
    ["USED", [[{ id: "sp1" }], [sponsorshipRow({ status: "USED" })]]],
    ["TARGETED", [[{ id: "sp1" }], [sponsorshipRow({ targetRegistrationId: "reg-target" })]]],
    ["LINKED", [[{ id: "sp1" }], [sponsorshipRow()], [{ value: 1 }]]],
    ["CLAIMED", [[{ id: "sp1" }], [sponsorshipRow()], [{ value: 0 }], [{ id: "reg-old", createdAt: new Date() }]]],
  ])("is used when the code is %s", async (reason, results) => {
    const { tx } = fakeTx(results as unknown[][]);
    expect(await claimSponsorshipCodeTxn(tx, "ev1", "SP-ABCD2345")).toEqual({
      outcome: "used",
      reason,
      sponsorshipId: "sp1",
    });
  });

  it("refuses to run outside a transaction", async () => {
    const { tx } = fakeTx([], { transaction: false });
    await expect(claimSponsorshipCodeTxn(tx, "ev1", "SP-ABCD2345")).rejects.toThrow(/inside a transaction/);
  });
});

describe("linkSponsorshipUsageTxn", () => {
  const priceBreakdown = {
    calculatedBasePrice: 200,
    accessItems: [
      { accessId: "gala", name: "Gala", unitPrice: 80, quantity: 1, subtotal: 80 },
      { accessId: "tour", name: "Tour", unitPrice: 50, quantity: 1, subtotal: 50 },
    ],
    subtotal: 330,
  };

  it("inserts the usage at what the sponsorship covers, then sets it USED", async () => {
    const usage = { id: "use1", sponsorshipId: "sp1", registrationId: "reg1", amountApplied: 280 };
    const { tx, queries } = fakeTx([[usage], [{ id: "sp1" }]]);
    const result = await linkSponsorshipUsageTxn(tx, {
      sponsorship: sponsorshipRow() as LinkableSponsorship,
      registrationId: "reg1",
      priceBreakdown: priceBreakdown as never,
      appliedBy: "PUBLIC",
    });

    expect(result).toBe(usage);
    expect(queries[0].sql).toMatch(/^insert into "sponsorship_usages"/);
    // base 200 + covered gala 80, capped by the sponsorship's 300
    expect(queries[0].params).toEqual(expect.arrayContaining(["sp1", "reg1", 280, "PUBLIC"]));
    expect(queries[1].sql).toMatch(/^update "sponsorships" set "status" = \$1/);
    expect(queries[1].sql).toContain(`"sponsorships"."status" <> $`);
  });

  it("throws when the sponsorship could not be set USED", async () => {
    const { tx } = fakeTx([[{ id: "use1" }], []]);
    await expect(
      linkSponsorshipUsageTxn(tx, {
        sponsorship: sponsorshipRow() as LinkableSponsorship,
        registrationId: "reg1",
        priceBreakdown: priceBreakdown as never,
        appliedBy: "PUBLIC",
      }),
    ).rejects.toThrow(/could not be set USED/);
  });
});

describe("findPendingSponsorships", () => {
  it("quotes only PENDING codes open to anyone (no target registration)", async () => {
    const { tx, queries } = fakeTx([[]]);
    await findPendingSponsorships("ev1", ["SP-ABCD2345"], tx);
    expect(queries[0].sql).toContain(`"sponsorships"."status" = $`);
    expect(queries[0].sql).toContain(`"sponsorships"."target_registration_id" is null`);
  });
});

import { describe, expect, it } from "vitest";
import {
  PAID_REPAIR_MANIFEST_KIND,
  PaidRepairManifestError,
  allowedPaidRepairActions,
  classifyPaidRepairCandidate,
  parsePaidRepairManifest,
  type RepairAuditEntry,
  type RepairRegistrationFacts,
} from "./paid-repair-rules";

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const at = (iso: string) => new Date(`2026-${iso}T00:00:00.000Z`);

function manifest(rows: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    kind: PAID_REPAIR_MANIFEST_KIND,
    version: 1,
    generatedAt: "2026-09-26T00:00:00.000Z",
    since: SINCE.toISOString(),
    eventId: null,
    rows,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-1",
    section: "A",
    proposedAction: "BACKFILL_PAID",
    action: "BACKFILL_PAID",
    expected: { paymentStatus: "PAID", paidAmount: 0, updatedAt: "2026-07-01T10:00:00.000Z" },
    seatDelta: { BACKFILL_PAID: {}, CONVERT_PARTIAL: { "acc-1": -1 } },
    info: { detail: "ignored" },
    ...overrides,
  };
}

function problemsOf(input: unknown): string[] {
  try {
    parsePaidRepairManifest(input);
  } catch (err) {
    expect(err).toBeInstanceOf(PaidRepairManifestError);
    return (err as PaidRepairManifestError).problems;
  }
  throw new Error("expected the manifest to be refused");
}

describe("allowedPaidRepairActions", () => {
  it("A rows are PAID: backfill, convert or skip", () => {
    expect(allowedPaidRepairActions("A", "PAID")).toEqual(["BACKFILL_PAID", "CONVERT_PARTIAL", "SKIP"]);
    expect(allowedPaidRepairActions("A", "PARTIAL")).toEqual([]);
  });

  it.each(["B1", "B2", "B3"] as const)("%s rows are PENDING/PARTIAL: re-promote or skip", (section) => {
    expect(allowedPaidRepairActions(section, "PENDING")).toEqual(["REPROMOTE_PAID", "SKIP"]);
    expect(allowedPaidRepairActions(section, "PARTIAL")).toEqual(["REPROMOTE_PAID", "SKIP"]);
    expect(allowedPaidRepairActions(section, "PAID")).toEqual([]);
  });
});

describe("parsePaidRepairManifest", () => {
  it("returns the approved rows and ignores the informational fields", () => {
    const parsed = parsePaidRepairManifest(
      manifest([
        row(),
        row({
          id: "reg-2",
          section: "B2",
          proposedAction: null,
          action: "SKIP",
          expected: { paymentStatus: "PARTIAL", paidAmount: 50, updatedAt: "2026-07-02T00:00:00.000Z" },
        }),
      ]),
    );
    expect(parsed).toEqual({
      since: SINCE,
      eventId: null,
      rows: [
        {
          id: "reg-1",
          section: "A",
          action: "BACKFILL_PAID",
          expected: { paymentStatus: "PAID", paidAmount: 0, updatedAt: "2026-07-01T10:00:00.000Z" },
        },
        {
          id: "reg-2",
          section: "B2",
          action: "SKIP",
          expected: { paymentStatus: "PARTIAL", paidAmount: 50, updatedAt: "2026-07-02T00:00:00.000Z" },
        },
      ],
    });
  });

  it("accepts an empty manifest", () => {
    expect(parsePaidRepairManifest(manifest([])).rows).toEqual([]);
  });

  it("refuses a row whose action is not allowed for its section", () => {
    expect(problemsOf(manifest([row({ action: "REPROMOTE_PAID" })]))).toEqual([
      "row 0 (reg-1): action REPROMOTE_PAID is not allowed for section A with status PAID (allowed: BACKFILL_PAID, CONVERT_PARTIAL, SKIP)",
    ]);
    expect(
      problemsOf(
        manifest([
          row({
            section: "B1",
            action: "BACKFILL_PAID",
            expected: { paymentStatus: "PENDING", paidAmount: 0, updatedAt: "2026-07-01T00:00:00.000Z" },
          }),
        ]),
      ),
    ).toEqual([
      "row 0 (reg-1): action BACKFILL_PAID is not allowed for section B1 with status PENDING (allowed: REPROMOTE_PAID, SKIP)",
    ]);
  });

  it("refuses a row whose section and expected status disagree, even for SKIP", () => {
    expect(
      problemsOf(
        manifest([row({ action: "SKIP", expected: { paymentStatus: "PENDING", paidAmount: 0, updatedAt: "2026-07-01T00:00:00Z" } })]),
      ),
    ).toEqual(["row 0 (reg-1): action SKIP is not allowed for section A with status PENDING (no action is: section and status disagree)"]);
  });

  it("refuses the whole manifest when one row is not reviewed, and lists every problem", () => {
    const problems = problemsOf(
      manifest([
        row(),
        row({ id: "reg-2", action: null }),
        row({ id: "reg-3", action: "DELETE" }),
        row({ id: "reg-1" }),
      ]),
    );
    expect(problems).toEqual([
      "row 1 (reg-2): no action: the approver sets one of BACKFILL_PAID, CONVERT_PARTIAL, REPROMOTE_PAID, SKIP (or removes the row)",
      'row 2 (reg-3): unknown action "DELETE"',
      "row 3 (reg-1): duplicate id",
    ]);
  });

  it("refuses malformed rows", () => {
    expect(
      problemsOf(
        manifest([
          "reg-1",
          row({ id: "" }),
          row({ id: "reg-3", section: "C" }),
          row({ id: "reg-4", expected: { paymentStatus: "UNPAID", paidAmount: -1, updatedAt: "yesterday" } }),
          row({ id: "reg-5", expected: undefined }),
          row({ id: "reg-6", expected: { paymentStatus: "PAID", paidAmount: 1.5, updatedAt: "2026-07-01T00:00:00Z" } }),
        ]),
      ),
    ).toEqual([
      "row 0: not an object",
      "row 1: id must be a non-empty string",
      "row 2 (reg-3): section must be one of A, B1, B2, B3",
      "row 3 (reg-4): expected.paymentStatus must be a payment status",
      "row 3 (reg-4): expected.paidAmount must be a non-negative integer",
      "row 3 (reg-4): expected.updatedAt must be an ISO date",
      "row 4 (reg-5): expected must be an object",
      "row 5 (reg-6): expected.paidAmount must be a non-negative integer",
    ]);
  });

  it("refuses a manifest of another kind, version or shape", () => {
    expect(problemsOf(null)).toEqual(["the manifest is not a JSON object"]);
    expect(problemsOf([row()])).toEqual(["the manifest is not a JSON object"]);
    expect(problemsOf(manifest([], { kind: "other", version: 2, since: "soon", eventId: 7 }))).toEqual([
      `kind must be "${PAID_REPAIR_MANIFEST_KIND}"`,
      "version must be 1",
      "since must be an ISO date",
      "eventId must be a string or null",
    ]);
    expect(problemsOf(manifest([], { rows: {} }))).toEqual(["rows must be an array"]);
  });
});

function facts(overrides: Partial<RepairRegistrationFacts> = {}): RepairRegistrationFacts {
  return {
    paymentStatus: "PAID",
    paidAmount: 0,
    totalAmount: 300,
    sponsorshipAmount: 0,
    paidAt: at("05-01"),
    createdAt: at("04-01"),
    updatedAt: at("07-01"),
    lastEditedAt: null,
    ...overrides,
  };
}

let auditSeq = 0;
function audit(action: string, performedBy: string | null, day: string, changes: Record<string, unknown> = {}): RepairAuditEntry {
  auditSeq += 1;
  return { id: `audit-${String(auditSeq).padStart(3, "0")}`, action, performedBy, performedAt: at(day), changes };
}

const status = (from: string | null, to: string) => ({ paymentStatus: { old: from, new: to } });

describe("classifyPaidRepairCandidate", () => {
  describe("A: PAID with paid < net", () => {
    it("proposes BACKFILL_PAID when PAID was set without an amount", () => {
      const created = audit("CREATE", "admin-1", "04-01", { totalAmount: { old: null, new: 300 } });
      const result = classifyPaidRepairCandidate(facts(), [created], SINCE);
      expect(result).toMatchObject({ section: "A", proposedAction: "BACKFILL_PAID", flags: [], paidAt: at("05-01") });
      expect(result?.detail).toContain("paid 0 < net 300");
    });

    it("A is state-based: a row PAID before --since is still listed; paid_at falls back to the audit", () => {
      const confirm = audit("UPDATE", "admin-1", "02-01", status("PENDING", "PAID"));
      const result = classifyPaidRepairCandidate(facts({ paidAt: null, updatedAt: at("02-01") }), [confirm], SINCE);
      expect(result).toMatchObject({ section: "A", proposedAction: "BACKFILL_PAID", paidAt: at("02-01"), evidence: [confirm.id] });
    });

    it("flags a confirmation that recorded exactly the smaller amount (per-row decision)", () => {
      const confirm = audit("PAYMENT_CONFIRMED", "admin-1", "06-10", {
        ...status("VERIFYING", "PAID"),
        paidAmount: { old: 0, new: 200 },
      });
      const result = classifyPaidRepairCandidate(facts({ paidAmount: 200 }), [confirm], SINCE);
      expect(result).toMatchObject({ section: "A", proposedAction: null, flags: ["RECORDED_AMOUNT"], evidence: [confirm.id] });
    });

    it("flags a recorded amount even when the confirmation has no actor id", () => {
      const confirm = audit("PAYMENT_CONFIRMED", null, "06-10", { ...status("VERIFYING", "PAID"), paidAmount: { old: 0, new: 150 } });
      expect(classifyPaidRepairCandidate(facts({ paidAmount: 150 }), [confirm], SINCE)).toMatchObject({
        proposedAction: null,
        flags: ["RECORDED_AMOUNT"],
      });
    });

    it("an amount recorded before PAID was set without one still proposes the backfill", () => {
      const partial = audit("PAYMENT_CONFIRMED", "admin-1", "06-10", {
        ...status("PENDING", "PARTIAL"),
        paidAmount: { old: 0, new: 100 },
      });
      const paid = audit("UPDATE", "admin-1", "06-20", status("PARTIAL", "PAID"));
      const result = classifyPaidRepairCandidate(facts({ paidAmount: 100 }), [paid, partial], SINCE);
      expect(result).toMatchObject({ section: "A", proposedAction: "BACKFILL_PAID", flags: [], evidence: [paid.id] });
    });

    it("flags a price change after the registration became PAID", () => {
      const paid = audit("UPDATE", "admin-1", "06-10", status("PENDING", "PAID"));
      const selfEdit = audit("UPDATE", "PUBLIC", "06-15", { accessSelections: { old: [], new: [] } });
      const result = classifyPaidRepairCandidate(facts(), [paid, selfEdit], SINCE);
      expect(result).toMatchObject({ proposedAction: null, flags: ["PRICE_CHANGED_AFTER_PAID"], evidence: [paid.id, selfEdit.id] });
    });

    it("is not a candidate when paid in full", () => {
      expect(classifyPaidRepairCandidate(facts({ paidAmount: 300 }), [], SINCE)).toBeNull();
      expect(classifyPaidRepairCandidate(facts({ sponsorshipAmount: 300 }), [], SINCE)).toBeNull();
    });
  });

  describe("B1: admin-edit demotion", () => {
    const confirm = (day = "06-05") =>
      audit("PAYMENT_CONFIRMED", "admin-1", day, { ...status("PENDING", "PAID"), paidAmount: { old: 0, new: 0 } });
    const demotion = (day = "06-20", to = "PENDING") =>
      audit("UPDATE", "admin-2", day, { ...status("PAID", to), totalAmount: { old: 250, new: 300 } });

    it("proposes REPROMOTE_PAID with paid_at from the confirmation", () => {
      const paid = confirm();
      const demoted = demotion();
      const result = classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING", paidAt: null }), [demoted, paid], SINCE);
      expect(result).toMatchObject({
        section: "B1",
        proposedAction: "REPROMOTE_PAID",
        flags: [],
        paidAt: at("06-05"),
        evidence: [demoted.id, paid.id],
      });
    });

    it("flags a row whose status changed again since the demotion", () => {
      const result = classifyPaidRepairCandidate(
        facts({ paymentStatus: "PARTIAL", paidAmount: 50, paidAt: null }),
        [confirm(), demotion("06-20", "PENDING")],
        SINCE,
      );
      expect(result).toMatchObject({ section: "B1", proposedAction: null, flags: ["STATUS_CHANGED_SINCE"] });
    });

    it("an explicit status change without re-pricing is deliberate", () => {
      const explicit = audit("UPDATE", "admin-2", "06-20", status("PAID", "PENDING"));
      expect(classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING" }), [confirm(), explicit], SINCE)).toBeNull();
    });

    it("ignores demotions before --since", () => {
      expect(
        classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING" }), [confirm("04-05"), demotion("05-20")], SINCE),
      ).toBeNull();
    });
  });

  describe("B2: self-edit demotion (status history rebuilt)", () => {
    it("proposes REPROMOTE_PAID after a self-edit following the last audited PAID", () => {
      const paid = audit("PAYMENT_CONFIRMED", "admin-1", "06-05", { ...status("VERIFYING", "PAID"), paidAmount: { old: 0, new: 280 } });
      const selfEdit = audit("UPDATE", "PUBLIC", "06-25", { formData: { old: {}, new: {} } });
      const result = classifyPaidRepairCandidate(
        facts({ paymentStatus: "PARTIAL", paidAmount: 280, paidAt: null, lastEditedAt: at("06-25") }),
        [paid, selfEdit],
        SINCE,
      );
      expect(result).toMatchObject({
        section: "B2",
        proposedAction: "REPROMOTE_PAID",
        paidAt: at("06-05"),
        evidence: [paid.id, selfEdit.id],
      });
    });

    it("a self-edit that audited nothing still shows in last_edited_at", () => {
      const paid = audit("UPDATE", "admin-1", "06-05", status("PENDING", "PAID"));
      const result = classifyPaidRepairCandidate(
        facts({ paymentStatus: "PENDING", paidAt: null, lastEditedAt: at("06-25") }),
        [paid],
        SINCE,
      );
      expect(result).toMatchObject({ section: "B2", proposedAction: "REPROMOTE_PAID" });
    });

    it("flags a demotion nothing explains", () => {
      const paid = audit("UPDATE", "admin-1", "06-05", status("PENDING", "PAID"));
      const result = classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING", paidAt: null }), [paid], SINCE);
      expect(result).toMatchObject({ section: "B2", proposedAction: null, flags: ["NO_SELF_EDIT_EVIDENCE"] });
    });

    it("ignores self-edits before --since", () => {
      const paid = audit("UPDATE", "admin-1", "03-05", status("PENDING", "PAID"));
      const selfEdit = audit("UPDATE", "PUBLIC", "04-25", { phone: { old: "1", new: "2" } });
      expect(
        classifyPaidRepairCandidate(
          facts({ paymentStatus: "PENDING", paidAt: null, lastEditedAt: at("04-25"), updatedAt: at("06-02") }),
          [paid, selfEdit],
          SINCE,
        ),
      ).toBeNull();
    });
  });

  describe("B3: admin-created, re-priced after --since", () => {
    it("lists the row for manual review", () => {
      const created = audit("CREATE", "admin-1", "05-01", { totalAmount: { old: null, new: 300 } });
      const repriced = audit("UPDATE", "admin-1", "06-15", { totalAmount: { old: 250, new: 300 } });
      const result = classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING", paidAt: null }), [created, repriced], SINCE);
      expect(result).toMatchObject({
        section: "B3",
        proposedAction: null,
        flags: ["NO_STATUS_HISTORY"],
        paidAt: at("05-01"),
        evidence: [created.id, repriced.id],
      });
    });

    it("public signups are never PAID without an audited status: not candidates", () => {
      const created = audit("CREATE", "PUBLIC", "05-01");
      const selfEdit = audit("UPDATE", "PUBLIC", "06-15", { formData: { old: {}, new: {} } });
      expect(classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING", paidAt: null }), [created, selfEdit], SINCE)).toBeNull();
    });

    it("an admin-created row not re-priced since is not a candidate", () => {
      const created = audit("CREATE", "admin-1", "05-01");
      expect(
        classifyPaidRepairCandidate(facts({ paymentStatus: "PENDING", paidAt: null }), [created], SINCE),
      ).toBeNull();
    });
  });

  it("a row the repair converted to PARTIAL is not listed again", () => {
    const repaired = audit("DATA_REPAIR_SETTLEMENT", "SYSTEM:repair-paid-settlement", "09-01", {
      ...status("PAID", "PARTIAL"),
      totalAmount: { old: 300, new: 300 },
    });
    const created = audit("CREATE", "admin-1", "05-01");
    expect(
      classifyPaidRepairCandidate(
        facts({ paymentStatus: "PARTIAL", paidAmount: 100, paidAt: null, updatedAt: at("09-01") }),
        [created, repaired],
        SINCE,
      ),
    ).toBeNull();
  });

  it("VERIFYING, SPONSORED, WAIVED and REFUNDED rows are never candidates", () => {
    for (const paymentStatus of ["VERIFYING", "SPONSORED", "WAIVED", "REFUNDED"]) {
      expect(classifyPaidRepairCandidate(facts({ paymentStatus }), [], SINCE)).toBeNull();
    }
  });
});

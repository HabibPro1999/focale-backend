import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { DbExecutor } from "../client";
import {
  getEmailTemplateTenantScope,
  getEventTenantScope,
  getRegistrationTenantScope,
  getSponsorshipTenantScope,
} from "./tenant-scope";

// A proxy driver records every statement and answers with canned rows, so the
// tests see the real generated SQL (one statement per scope) and the real row
// mapping. The DB tier runs the same reads against a migrated database.
function recordingDb(rows: unknown[][]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(
    async (sql, params) => {
      statements.push({ sql, params });
      return { rows };
    },
    { casing: "snake_case" },
  );
  return { db: db as unknown as DbExecutor, statements };
}

const eventRow = ["evt-1", "client-1", "OPEN", "summit"];
const clientRow = ["client-1", true, ["registrations", "emails"]];
const scope = {
  event: { id: "evt-1", clientId: "client-1", status: "OPEN", slug: "summit" },
  client: { id: "client-1", active: true, enabledModules: ["registrations", "emails"] },
};

describe("tenant scope reads (5.4)", () => {
  it("event: one statement joining the client, keyed by the event id", async () => {
    const { db, statements } = recordingDb([[...eventRow, ...clientRow]]);
    await expect(getEventTenantScope("evt-1", db)).resolves.toEqual(scope);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(
      /from "events" inner join "clients" on "clients"\."id" = "events"\."client_id" where "events"\."id" = \$1 limit \$2/,
    );
    expect(statements[0]!.params).toEqual(["evt-1", 1]);
  });

  it("registration: one statement through the event to the client", async () => {
    const { db, statements } = recordingDb([["reg-1", ...eventRow, ...clientRow]]);
    await expect(getRegistrationTenantScope("reg-1", db)).resolves.toEqual({
      registration: { id: "reg-1" },
      ...scope,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(
      /from "registrations" inner join "events" on "events"\."id" = "registrations"\."event_id" inner join "clients" on "clients"\."id" = "events"\."client_id" where "registrations"\."id" = \$1/,
    );
  });

  it("sponsorship: one statement through the event to the client", async () => {
    const { db, statements } = recordingDb([["sp-1", ...eventRow, ...clientRow]]);
    await expect(getSponsorshipTenantScope("sp-1", db)).resolves.toEqual({
      sponsorship: { id: "sp-1" },
      ...scope,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toMatch(
      /from "sponsorships" inner join "events" on "events"\."id" = "sponsorships"\."event_id" inner join "clients" on "clients"\."id" = "events"\."client_id" where "sponsorships"\."id" = \$1/,
    );
  });

  it("email template: left joins, so a client-level template has no event or client", async () => {
    const withEvent = recordingDb([["tpl-1", "client-1", "evt-1", ...eventRow, ...clientRow]]);
    await expect(getEmailTemplateTenantScope("tpl-1", withEvent.db)).resolves.toEqual({
      template: { id: "tpl-1", clientId: "client-1", eventId: "evt-1" },
      ...scope,
    });
    expect(withEvent.statements).toHaveLength(1);
    expect(withEvent.statements[0]!.sql).toMatch(
      /from "email_templates" left join "events" on "events"\."id" = "email_templates"\."event_id" left join "clients" on "clients"\."id" = "events"\."client_id" where "email_templates"\."id" = \$1/,
    );

    const clientLevel = recordingDb([["tpl-2", "client-1", null, null, null, null, null, null, null, null]]);
    await expect(getEmailTemplateTenantScope("tpl-2", clientLevel.db)).resolves.toEqual({
      template: { id: "tpl-2", clientId: "client-1", eventId: null },
      event: null,
      client: null,
    });
  });

  it("returns null when the resource does not exist", async () => {
    for (const read of [
      getEventTenantScope,
      getRegistrationTenantScope,
      getSponsorshipTenantScope,
      getEmailTemplateTenantScope,
    ]) {
      const { db, statements } = recordingDb([]);
      await expect(read("missing", db)).resolves.toBeNull();
      expect(statements).toHaveLength(1);
    }
  });
});

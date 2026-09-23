import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

describe.runIf(dbTestsEnabled())("migration tier: certificate template scope", () => {
  let scratch: ScratchDatabase;
  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "certificate_scope", to: "0005" });
    await scratch.client.query(`
      INSERT INTO clients (id, name, updated_at) VALUES ('cli-1', 'Client', now());
      INSERT INTO events (id, client_id, name, slug, start_date, end_date, updated_at)
      VALUES ('evt-1', 'cli-1', 'Event', 'event', now(), now(), now());
    `);
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("adds the scope column and nullable allowed final types", async () => {
    const scope = await scratch.client.query<{
      is_nullable: string;
      data_type: string;
      column_default: string | null;
    }>(`SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_name='certificate_templates' AND column_name='scope'`);
    expect(scope.rows).toHaveLength(1);
    expect(scope.rows[0]).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(scope.rows[0].column_default).toContain("BOTH");

    const allowed = await scratch.client.query<{
      is_nullable: string;
      udt_name: string;
      column_default: string | null;
    }>(`SELECT is_nullable, udt_name, column_default FROM information_schema.columns
        WHERE table_name='certificate_templates' AND column_name='allowed_abstract_final_types'`);
    expect(allowed.rows).toHaveLength(1);
    expect(allowed.rows[0]).toEqual({
      is_nullable: "YES",
      udt_name: "_AbstractFinalType",
      column_default: null,
    });
  });

  it("enforces scope values and accepts existing abstract final types", async () => {
    await scratch.client.query(`
      INSERT INTO certificate_templates
        (id,event_id,name,template_url,template_width,template_height,updated_at)
      VALUES ('tpl-default','evt-1','Default Cert','',0,0,now())
    `);
    const result = await scratch.client.query<{ scope: string; allowed_abstract_final_types: string | null }>(
      `SELECT scope, allowed_abstract_final_types FROM certificate_templates WHERE id='tpl-default'`,
    );
    expect(result.rows[0]).toEqual({ scope: "BOTH", allowed_abstract_final_types: null });

    await expect(scratch.client.query(`
      INSERT INTO certificate_templates
        (id,event_id,name,template_url,template_width,template_height,scope,updated_at)
      VALUES ('tpl-bad','evt-1','Bad Cert','',0,0,'EVERYONE',now())
    `)).rejects.toThrow(/check constraint/i);

    await scratch.client.query(`
      INSERT INTO certificate_templates
        (id,event_id,name,template_url,template_width,template_height,scope,allowed_abstract_final_types,updated_at)
      VALUES ('tpl-abstract','evt-1','Abstract Cert','',0,0,'ABSTRACT',ARRAY['POSTER']::"AbstractFinalType"[],now())
    `);
    const accepted = await scratch.client.query<{ scope: string; allowed_abstract_final_types: string }>(
      `SELECT scope, allowed_abstract_final_types FROM certificate_templates WHERE id='tpl-abstract'`,
    );
    expect(accepted.rows[0]).toEqual({ scope: "ABSTRACT", allowed_abstract_final_types: "{POSTER}" });
  });
});

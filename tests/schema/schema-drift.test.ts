import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("schema drift guards", () => {
  it("keeps EmailTemplate trigger uniqueness in raw partial indexes", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const abstractSubmissionMigration = readFileSync(
      "prisma/migrations/20260426100000_add_abstracts_submission/migration.sql",
      "utf8",
    );

    expect(schema).not.toContain("@@unique([clientId, trigger, eventId])");
    expect(abstractSubmissionMigration).toContain(
      'DROP INDEX IF EXISTS "email_templates_client_id_trigger_event_id_key"',
    );
    expect(abstractSubmissionMigration).toContain(
      'CREATE UNIQUE INDEX "email_template_registration_uniq"',
    );
    expect(abstractSubmissionMigration).toContain(
      'CREATE UNIQUE INDEX "email_template_abstract_uniq"',
    );
  });
});

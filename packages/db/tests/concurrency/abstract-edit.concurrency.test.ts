import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { abstractRevisions, editAbstractTxn, getDb } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent } from "../helpers/factories";

// M3: editAbstractTxn does read-max-then-insert for abstract_revisions.revisionNo.
// Under plain READ COMMITTED (no retry), concurrent edits of the same abstract can
// both read the same max and race on abstract_revisions_abstract_id_revision_no_key
// — the loser's raw 23505 was never caught by editAbstractTxn (its catch only
// matches the author-email constraint), so it rejected outright. The fix moves
// editAbstractTxn onto withSerializableTxn (+ retry): a genuine overlap now
// surfaces as a 40001 that's transparently retried, so every racing edit
// eventually succeeds with a distinct revisionNo. Fan-out of 6 mirrors the
// reliably-reproducing concurrency pattern already used in
// score.concurrency.test.ts (no artificial barrier needed at this fan-out).
describe.runIf(dbTestsEnabled())("concurrency: abstract edit revision numbering", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("racing edits of the same abstract all succeed with distinct revisionNo", async () => {
    const fanout = 6;
    const event = await seedEvent({ status: "OPEN" });
    const abstract = await seedAbstract({ eventId: event.id });

    const results = await Promise.all(
      Array.from({ length: fanout }, (_, i) =>
        editAbstractTxn({
          id: abstract.id,
          authorFirstName: abstract.authorFirstName,
          authorLastName: abstract.authorLastName,
          authorAffiliation: abstract.authorAffiliation,
          authorEmail: abstract.authorEmail,
          authorEmailNormalized: abstract.authorEmail.toLowerCase(),
          authorPhone: abstract.authorPhone,
          requestedType: abstract.requestedType,
          content: { body: `edit ${i}` },
          coAuthors: [],
          additionalFieldsData: {},
          registrationId: null,
          themeIds: [],
          revisionSnapshot: { body: `edit ${i}` },
          lastEditedAt: new Date(),
        }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);

    const revisions = await getDb()
      .select({ revisionNo: abstractRevisions.revisionNo })
      .from(abstractRevisions)
      .where(eq(abstractRevisions.abstractId, abstract.id));

    expect(revisions).toHaveLength(fanout);
    expect(new Set(revisions.map((r) => r.revisionNo)).size).toBe(fanout);
  });
});

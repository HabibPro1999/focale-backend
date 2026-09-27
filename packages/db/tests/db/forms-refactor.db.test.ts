import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findFormByIdWithEvent, findActiveRegistrationFormById, updateSponsorFormSchemaModeChange,
  updateSponsorshipSettingsModeChange,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedClient, seedEvent, seedForm, seedSponsorshipBatch } from "../helpers/factories";

async function fixture(type = "SPONSOR") {
  const client = await seedClient();
  const event = await seedEvent({ clientId: client.id, status: "OPEN", endDate: new Date("2099-01-01T00:00:00Z") });
  const form = await seedForm({ eventId: event.id, type, schemaVersion: 3, schema: {
    marker: "keep", sponsorshipSettings: { sponsorshipMode: "CODE", custom: "old", autoApproveSponsorship: false },
  } });
  return { event, form };
}

describe.runIf(dbTestsEnabled())("form read and mode-change characterization", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("keeps the form/event projection and registration-only filtering", async () => {
    const { event, form } = await fixture();
    const expected = { ...form, event: { clientId: event.clientId, status: event.status, endDate: event.endDate } };
    expect(await findFormByIdWithEvent(form.id)).toEqual(expected);
    expect(await findActiveRegistrationFormById(form.id)).toBeNull();
    const registration = await seedForm({ eventId: event.id, type: "REGISTRATION" });
    expect(await findActiveRegistrationFormById(registration.id)).toEqual({
      ...registration, event: expected.event,
    });
    expect(await findFormByIdWithEvent("missing")).toBeNull();
  });
  it("schema mode change applies metadata and increments the existing version", async () => {
    const { form } = await fixture();
    const nextSchema = { steps: [], sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } };
    const result = await updateSponsorFormSchemaModeChange({ id: form.id, patch: { name: "Changed", successTitle: null }, nextSchema, newMode: "LINKED_ACCOUNT" });
    expect(result).toMatchObject({ ok: true, form: { name: "Changed", schema: nextSchema, schemaVersion: 4, successTitle: null } });
  });
  it("settings shallow-merge retains unknown schema/settings keys without a version bump", async () => {
    const { form } = await fixture();
    expect(await updateSponsorshipSettingsModeChange(form.id, { sponsorshipMode: "LINKED_ACCOUNT", autoApproveSponsorship: true })).toMatchObject({
      ok: true, form: { schemaVersion: 3, schema: { marker: "keep", sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT", custom: "old", autoApproveSponsorship: true } } },
    });
  });
  it("submitted batches lock both mode-changing workflows", async () => {
    const { event, form } = await fixture();
    await seedSponsorshipBatch({ eventId: event.id, formId: form.id });
    expect(await updateSponsorshipSettingsModeChange(form.id, { sponsorshipMode: "LINKED_ACCOUNT" })).toEqual({ ok: false, reason: "locked" });
    expect(await updateSponsorFormSchemaModeChange({ id: form.id, patch: {}, nextSchema: {}, newMode: "LINKED_ACCOUNT" })).toEqual({ ok: false, reason: "locked" });
  });
  it("preserves each workflow's distinct missing/type-mismatch reason", async () => {
    const { form } = await fixture("REGISTRATION");
    expect(await updateSponsorshipSettingsModeChange("missing", { sponsorshipMode: "CODE" })).toEqual({ ok: false, reason: "not_found" });
    expect(await updateSponsorFormSchemaModeChange({ id: "missing", patch: {}, nextSchema: {}, newMode: "CODE" })).toEqual({ ok: false, reason: "not_found" });
    expect(await updateSponsorshipSettingsModeChange(form.id, { sponsorshipMode: "CODE" })).toEqual({ ok: false, reason: "not_sponsor" });
    expect(await updateSponsorFormSchemaModeChange({ id: form.id, patch: {}, nextSchema: {}, newMode: "CODE" })).toEqual({ ok: false, reason: "type_changed" });
  });
});

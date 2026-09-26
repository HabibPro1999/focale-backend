import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "@app/db";
import { getOrCreateAbstractConfig, isTransactionExecutor } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import {
  seedAbstract,
  seedAbstractConfig,
  seedEvent,
} from "../../../../../packages/db/tests/helpers/factories";
import { auditRowsOf } from "../../../../../packages/db/tests/helpers/sponsorship-inspect";
import { AbstractsConfigService } from "./abstracts.config.service";

// Config writes and their audit rows commit together: a failed audit insert
// rolls the update back (and the forced-mode record with it), and a patch
// refused by validation records nothing.
//
// The real query functions run; insertAuditLog is wrapped so a test can make
// one audit action fail inside the transaction.
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return { ...real, insertAuditLog: vi.fn(real.insertAuditLog) };
});

const mocked = vi.mocked(db);
const service = new AbstractsConfigService();
const performedBy = "admin-1";

async function realInsertAuditLog(
  ...args: Parameters<typeof db.insertAuditLog>
): Promise<void> {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return actual.insertAuditLog(...args);
}

/** Make the audit insert for `action` throw; the other audit inserts run for real. */
function failAuditAction(action: string): Error {
  const failure = new Error(`injected ${action} audit failure`);
  mocked.insertAuditLog.mockImplementation(async (values, exec) => {
    if (values.action === action) throw failure;
    return realInsertAuditLog(values, exec);
  });
  return failure;
}

/** The audit actions attempted, and whether they all ran on one transaction. */
function auditAttempts() {
  const calls = mocked.insertAuditLog.mock.calls;
  const executors = new Set(calls.map(([, exec]) => exec));
  return {
    actions: calls.map(([values]) => values.action),
    oneTransaction: executors.size === 1 && [...executors].every(isTransactionExecutor),
  };
}

async function seedLockedConfig() {
  const event = await seedEvent({ status: "OPEN" });
  const config = await seedAbstractConfig({ eventId: event.id });
  // An abstract locks the submission mode: changing it needs force=true.
  await seedAbstract({ eventId: event.id, status: "SUBMITTED" });
  return { event, config };
}

describe.runIf(dbTestsEnabled())("abstracts config writes and their audit rows are atomic", () => {
  afterEach(() => {
    mocked.insertAuditLog.mockClear();
    mocked.insertAuditLog.mockImplementation(realInsertAuditLog);
  });

  it("updateConfig: a failing UPDATE audit rolls back the update and the forced-mode record", async () => {
    const { event, config } = await seedLockedConfig();
    const failure = failAuditAction("UPDATE");

    await expect(
      service.updateConfig(
        event.id,
        { submissionMode: "STRUCTURED", force: true, editingEnabled: true },
        performedBy,
      ),
    ).rejects.toBe(failure);

    // The forced-mode row was written in the update's transaction, then undone.
    expect(auditAttempts()).toEqual({
      actions: ["mode_force_changed", "UPDATE"],
      oneTransaction: true,
    });
    expect(await auditRowsOf("AbstractConfig", config.id)).toEqual([]);
    const after = await getOrCreateAbstractConfig(event.id);
    expect(after.submissionMode).toBe(config.submissionMode);
    expect(after.editingEnabled).toBe(config.editingEnabled);
  });

  it("updateConfig: a forced mode change refused by the deadline check leaves no audit row", async () => {
    const { event, config } = await seedLockedConfig();

    await expect(
      service.updateConfig(
        event.id,
        {
          submissionMode: "STRUCTURED",
          force: true,
          submissionStartAt: "2026-06-01T00:00:00.000Z",
          submissionDeadline: "2026-05-01T00:00:00.000Z",
        },
        performedBy,
      ),
    ).rejects.toThrow(/deadline windows are inconsistent/);

    expect(auditAttempts().actions).toEqual([]);
    expect(await auditRowsOf("AbstractConfig", config.id)).toEqual([]);
    expect((await getOrCreateAbstractConfig(event.id)).submissionMode).toBe(config.submissionMode);
  });

  it("updateConfig: a forced mode change commits with both audit rows", async () => {
    const { event, config } = await seedLockedConfig();

    const updated = await service.updateConfig(
      event.id,
      { submissionMode: "STRUCTURED", force: true },
      performedBy,
    );

    expect(updated.submissionMode).toBe("STRUCTURED");
    expect(auditAttempts()).toEqual({
      actions: ["mode_force_changed", "UPDATE"],
      oneTransaction: true,
    });
    const rows = await auditRowsOf("AbstractConfig", config.id);
    expect(rows.map((r) => r.action).sort()).toEqual(["UPDATE", "mode_force_changed"]);
    expect(rows.every((r) => r.performedBy === performedBy)).toBe(true);
  });

  it("setAdditionalFields: a failing audit insert keeps the previous fields", async () => {
    const { event, config } = await seedLockedConfig();
    const failure = failAuditAction("UPDATE");

    await expect(
      service.setAdditionalFields(
        event.id,
        { fields: [{ id: "f1", type: "text", label: "Custom" }] },
        performedBy,
      ),
    ).rejects.toBe(failure);

    expect(auditAttempts()).toEqual({ actions: ["UPDATE"], oneTransaction: true });
    expect(await auditRowsOf("AbstractConfig", config.id)).toEqual([]);
    expect((await getOrCreateAbstractConfig(event.id)).additionalFieldsSchema).toEqual(
      config.additionalFieldsSchema,
    );
  });
});

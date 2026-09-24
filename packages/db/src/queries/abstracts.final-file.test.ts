import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../client";

// updateAbstractFinalFileTxn: lock the abstract row, let the caller re-validate
// the locked state, then write. No live DB — a fake tx records each step.
const txn = vi.hoisted(() => ({ tx: null as unknown }));
vi.mock("../txn", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTxn: vi.fn((fn: (tx: unknown) => unknown) => fn(txn.tx)),
}));

import { updateAbstractFinalFileTxn, type FinalFileUpdate } from "./abstracts";

const abstractRow = {
  id: "abstract-1",
  eventId: "event-1",
  status: "ACCEPTED",
  finalFileKey: "event-1/abstracts/abstract-1/final.pdf",
};
const configRow = { finalFileUploadEnabled: true, finalFileDeadline: null };

const fields: FinalFileUpdate = {
  finalFileKey: "event-1/abstracts/abstract-1/final-new.pdf",
  finalFileKind: "PDF",
  finalFileSize: 10,
  finalFileUploadedAt: new Date("2026-09-24T00:00:00.000Z"),
};
const audit = {
  entityType: "Abstract",
  entityId: "abstract-1",
  action: "final_file_upload",
  performedBy: "PUBLIC",
};

function fakeTx() {
  const lockModes: Array<string | undefined> = [];
  const select = (rows: unknown[]) => {
    let lock: string | undefined;
    const settle = () => {
      lockModes.push(lock);
      return Promise.resolve(rows);
    };
    const limited = {
      for: (mode: string) => {
        lock = mode;
        return settle();
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    const chain = { from: () => chain, where: () => chain, limit: () => limited };
    return chain;
  };
  const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi
      .fn()
      .mockReturnValueOnce(select([abstractRow]))
      .mockReturnValueOnce(select([configRow])),
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values })),
  };
  return { tx: tx as unknown as DbExecutor, lockModes, set, values, raw: tx };
}

describe("updateAbstractFinalFileTxn", () => {
  let fake: ReturnType<typeof fakeTx>;

  beforeEach(() => {
    fake = fakeTx();
    txn.tx = fake.tx;
  });

  it("locks the abstract row, validates the locked state, writes, and returns the replaced key", async () => {
    const prepare = vi.fn(() => ({ fields, audit }));

    const result = await updateAbstractFinalFileTxn("abstract-1", prepare);

    expect(fake.lockModes).toEqual(["update", undefined]);
    expect(prepare).toHaveBeenCalledWith({ ...abstractRow, config: configRow });
    expect(fake.set).toHaveBeenCalledWith(fields);
    expect(fake.values).toHaveBeenCalledWith(audit);
    expect(result).toEqual({ previousKey: abstractRow.finalFileKey });
  });

  it("writes nothing when the locked state is rejected", async () => {
    const rejected = new Error("status changed");

    await expect(
      updateAbstractFinalFileTxn("abstract-1", () => {
        throw rejected;
      }),
    ).rejects.toBe(rejected);

    expect(fake.raw.update).not.toHaveBeenCalled();
    expect(fake.raw.insert).not.toHaveBeenCalled();
  });
});

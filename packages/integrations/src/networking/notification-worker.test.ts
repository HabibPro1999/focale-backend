import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkingDeliveryRow } from "@app/db";
const db = vi.hoisted(() => ({
  claimNetworkingDeliveries: vi.fn(), refreshNetworkingDeliveryLease: vi.fn(),
  networkingDeliveryContext: vi.fn(), localizeNetworkingNotification: vi.fn(),
  updateNetworkingDelivery: vi.fn(), beginNetworkingEmailLog: vi.fn(), finishNetworkingEmailLog: vi.fn(),
}));
vi.mock("@app/db", () => db);
vi.mock("./delivery-policy", () => ({ networkingDeliverySkipReason: () => undefined }));
vi.mock("./notification-rendering", () => ({ renderNetworkingNotification: () => ({ title: "Title", body: "Body", subject: "Subject", attachments: [] }) }));
vi.mock("../email/providers", () => ({ getNetworkingEmailSender: () => undefined }));
import { processNetworkingDeliveries } from "./notification-worker";
const oldLease = new Date("2030-01-01T00:05:00Z");
const freshLease = new Date("2030-01-01T00:11:00Z");
const row = (lockedUntil: Date) => ({ id: "delivery", type: "OTP", eventId: "event", payload: {}, lockedUntil, attempts: 1 }) as NetworkingDeliveryRow;
const email = { name: "resend" as const, isConfigured: () => true, sendEmail: vi.fn(), handleWebhook: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  db.networkingDeliveryContext.mockResolvedValue({
    event: { clientId: "client", name: "Event" }, profile: { email: "test@example.test", firstName: "Test" },
    registration: { id: "registration" }, config: {}, subscriptions: [],
  });
  db.updateNetworkingDelivery.mockResolvedValue(true);
  db.beginNetworkingEmailLog.mockResolvedValue({ alreadySent: false });
  email.sendEmail.mockResolvedValue({ success: true, messageId: "message" });
});
it("a stalled claimant cannot renew or dispatch; the fresh claimant sends once", async () => {
  db.claimNetworkingDeliveries.mockResolvedValue([row(oldLease), row(freshLease)]);
  db.refreshNetworkingDeliveryLease.mockImplementation(async (item) => item.lockedUntil === freshLease);
  expect(await processNetworkingDeliveries({ email })).toEqual({ sent: 1, skipped: 0, failed: 0 });
  expect(email.sendEmail).toHaveBeenCalledOnce();
  expect(db.beginNetworkingEmailLog).toHaveBeenCalledOnce();
  expect(db.updateNetworkingDelivery.mock.calls.every(([item]) => item.lockedUntil === freshLease)).toBe(true);
});
it("aborts without dispatch when ownership is lost during preparation", async () => {
  db.claimNetworkingDeliveries.mockResolvedValue([row(freshLease)]);
  db.refreshNetworkingDeliveryLease.mockResolvedValueOnce(true).mockResolvedValue(false);
  await processNetworkingDeliveries({ email });
  expect(email.sendEmail).not.toHaveBeenCalled();
  expect(db.beginNetworkingEmailLog).not.toHaveBeenCalled();
});
it("refuses dispatch when tracking detects a live send or lost lease", async () => {
  db.claimNetworkingDeliveries.mockResolvedValue([row(freshLease)]);
  db.refreshNetworkingDeliveryLease.mockResolvedValue(true);
  db.beginNetworkingEmailLog.mockResolvedValue({ alreadySent: false, leaseLost: true });
  expect(await processNetworkingDeliveries({ email })).toEqual({ sent: 0, skipped: 0, failed: 0 });
  expect(email.sendEmail).not.toHaveBeenCalled();
});
it("rechecks ownership after tracking and immediately before provider dispatch", async () => {
  db.claimNetworkingDeliveries.mockResolvedValue([row(freshLease)]);
  db.refreshNetworkingDeliveryLease.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await processNetworkingDeliveries({ email });
  expect(db.beginNetworkingEmailLog).toHaveBeenCalledOnce();
  expect(email.sendEmail).not.toHaveBeenCalled();
});

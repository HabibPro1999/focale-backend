import { describe, expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingDeliveryRow } from "@app/db";
import { networkingDeliverySkipReason } from "./delivery-policy";
import type { NetworkingNotificationContext } from "./notification-rendering";

const now = new Date("2099-04-19T10:00:00.000Z");
const context = (consentPending: boolean) => ({
  event: { id: "event", status: "OPEN", clientId: "client" },
  client: { active: true, enabledModules: ["networking", "registrations", "emails"] },
  config: NetworkingConfigSchema.parse({ enabled: true }),
  profile: { id: "p", status: "ACTIVE", consent: false, withdrawnAt: null, email: "ann@example.test", emailPreference: "IMMEDIATE" },
  registration: { id: "r", eventId: "event", networkingOptIn: null, paymentStatus: "PAID" },
  challenge: { consumedAt: null, attempts: 0, expiresAt: new Date(now.getTime() + 600_000), email: "ann@example.test" },
  subscriptions: [], blocked: false, consentPending,
}) as unknown as NetworkingNotificationContext;
const row = (type: string) => ({ id: "d", type, eventId: "event", profileId: "p", payload: {} }) as unknown as NetworkingDeliveryRow;

describe("OTP delivery for undecided registrants (K1b)", () => {
  it("delivers the sign-in code to a consent-pending registrant", () => {
    expect(networkingDeliverySkipReason(row("OTP"), context(true), now)).toBeUndefined();
  });
  it("still refuses a registrant who is not consent-pending", () => {
    expect(networkingDeliverySkipReason(row("OTP"), context(false), now)).toBe("participant_ineligible");
  });
  it("never extends the exception beyond sign-in codes", () => {
    expect(networkingDeliverySkipReason(row("APPROVAL"), context(true), now)).toBe("participant_ineligible");
  });
});

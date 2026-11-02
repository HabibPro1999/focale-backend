import { beforeEach, expect, it, vi } from "vitest";
const one = vi.hoisted(() => vi.fn());
vi.mock("@app/db", () => ({ networkingTransaction: async (_event: string, run: Function) => run({ one }) }));
import { NetworkingMfaService } from "./networking.mfa.service";
import type { NetworkingContext } from "./networking.service";
const ctx = { event: { id: "e" }, profile: { id: "p" }, config: { requireSecondFactor: false } } as unknown as NetworkingContext;
beforeEach(() => one.mockReset());
it("codes an already enrolled authenticator as a 409 action conflict", async () => {
  one.mockResolvedValue({ enabledAt: new Date() });
  await expect(new NetworkingMfaService().enroll(ctx)).rejects.toMatchObject({ status: 409, response: { code: "NETWORKING_ACTION_NOT_ALLOWED" } });
});
it("codes disabling a required second factor as enforced, not as a pending verification", async () => {
  await expect(new NetworkingMfaService().verify({ ...ctx, config: { ...ctx.config, requireSecondFactor: true } }, "000000", "DISABLE")).rejects.toMatchObject({ status: 403, response: { code: "NETWORKING_MFA_ENFORCED" } });
});
it("codes invalid authenticator verification as a 400 validation error", async () => {
  one.mockResolvedValue(null);
  await expect(new NetworkingMfaService().verify(ctx, "000000")).rejects.toMatchObject({ status: 400, response: { code: "NETWORKING_VALIDATION" } });
});

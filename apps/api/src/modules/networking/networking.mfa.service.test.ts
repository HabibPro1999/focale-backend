import { beforeEach, expect, it, vi } from "vitest";
const one = vi.hoisted(() => vi.fn());
vi.mock("@app/db", () => ({ networkingTransaction: async (_event: string, run: Function) => run({ one }) }));
import { NetworkingMfaService } from "./networking.mfa.service";
import type { NetworkingContext } from "./networking.service";
const ctx = { event: { id: "e" }, profile: { id: "p" }, config: { requireSecondFactor: false } } as unknown as NetworkingContext;
beforeEach(() => one.mockReset());
it("codes an already enrolled authenticator", async () => {
  one.mockResolvedValue({ enabledAt: new Date() });
  await expect(new NetworkingMfaService().enroll(ctx)).rejects.toMatchObject({ response: { code: "NETWORKING_VALIDATION" } });
});
it("codes required MFA", async () => {
  await expect(new NetworkingMfaService().verify({ ...ctx, config: { ...ctx.config, requireSecondFactor: true } }, "000000", "DISABLE")).rejects.toMatchObject({ response: { code: "NETWORKING_MFA_REQUIRED" } });
});
it("codes invalid authenticator verification", async () => {
  one.mockResolvedValue(null);
  await expect(new NetworkingMfaService().verify(ctx, "000000")).rejects.toMatchObject({ response: { code: "NETWORKING_VALIDATION" } });
});

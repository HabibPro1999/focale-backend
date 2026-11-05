import { beforeEach, describe, expect, it, vi } from "vitest";

// The registrant's code redemption route: the edit token is required before
// the service runs (header preferred over ?token=).
const db = vi.hoisted(() => ({ getRegistrationEditToken: vi.fn() }));
vi.mock("@app/db", () => db);

import { ErrorCodes } from "@app/contracts";
import { SponsorshipCodePublicController } from "./sponsorships.public.controller";
import type { SponsorshipsPublicService } from "./sponsorships.public.service";

const TOKEN = "a".repeat(64);
const REG = "11111111-1111-4111-8111-111111111111";
const money = { paymentStatus: "SPONSORED", totalAmount: 300, sponsorshipAmount: 300, amountDue: 0 };

describe("POST /public/registrations/:id/sponsorship-code", () => {
  const service = { redeemSponsorshipCode: vi.fn() };
  const controller = new SponsorshipCodePublicController(service as unknown as SponsorshipsPublicService);

  beforeEach(() => {
    vi.clearAllMocks();
    db.getRegistrationEditToken.mockResolvedValue({ editToken: TOKEN });
    service.redeemSponsorshipCode.mockResolvedValue(money);
  });

  it("redeems with a valid header token", async () => {
    await expect(
      controller.redeem({ registrationId: REG }, {}, { code: "SP-ABCD" }, TOKEN),
    ).resolves.toEqual({ success: true, registration: money });
    expect(service.redeemSponsorshipCode).toHaveBeenCalledWith(REG, "SP-ABCD");
  });

  it("accepts the query token", async () => {
    await controller.redeem({ registrationId: REG }, { token: TOKEN }, { code: "SP-ABCD" });
    expect(service.redeemSponsorshipCode).toHaveBeenCalled();
  });

  it("401 without a token", async () => {
    await expect(
      controller.redeem({ registrationId: REG }, {}, { code: "SP-ABCD" }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_TOKEN, statusCode: 401 });
    expect(service.redeemSponsorshipCode).not.toHaveBeenCalled();
  });

  it("403 with another registration's token", async () => {
    await expect(
      controller.redeem({ registrationId: REG }, {}, { code: "SP-ABCD" }, "b".repeat(64)),
    ).rejects.toMatchObject({ code: ErrorCodes.FORBIDDEN, statusCode: 403 });
    expect(service.redeemSponsorshipCode).not.toHaveBeenCalled();
  });
});

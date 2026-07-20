import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationsController } from "./registrations.controller";
import type { RegistrationsService } from "./registrations.service";
import type { AuthUser } from "../../core/auth/user-cache";
import { getStorageProvider, extractStorageKeyFromUrl } from "@app/integrations";

vi.mock("@app/integrations", () => ({
  getStorageProvider: vi.fn(),
  extractStorageKeyFromUrl: vi.fn(),
}));

const superAdmin = { id: "u1", role: 0, clientId: null } as AuthUser;

function makeReply() {
  const reply: Record<string, unknown> = {};
  reply.header = vi.fn(() => reply);
  reply.type = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  reply.redirect = vi.fn(() => reply);
  return reply as unknown as {
    header: ReturnType<typeof vi.fn>;
    type: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };
}

function makeController(registration: unknown) {
  const service = {
    getRegistrationById: vi.fn(async () => registration),
  } as unknown as RegistrationsService;
  return new RegistrationsController(service);
}

describe("paymentProof — proxies bytes instead of redirecting (CORS)", () => {
  beforeEach(() => {
    vi.mocked(extractStorageKeyFromUrl).mockReset();
    vi.mocked(getStorageProvider).mockReset();
  });

  it("streams the stored file with its content type", async () => {
    const download = vi.fn(async () => ({
      buffer: Buffer.from("pdf-bytes"),
      contentType: "application/pdf",
    }));
    vi.mocked(extractStorageKeyFromUrl).mockReturnValue("proofs/reg-1.pdf");
    vi.mocked(getStorageProvider).mockReturnValue({ download } as never);

    const controller = makeController({
      paymentProofUrl: "https://storage/proofs/reg-1.pdf",
      event: { clientId: "c1" },
    });
    const reply = makeReply();

    await controller.paymentProof({ id: "reg-1" } as never, superAdmin, reply as never);

    expect(download).toHaveBeenCalledWith("proofs/reg-1.pdf");
    expect(reply.type).toHaveBeenCalledWith("application/pdf");
    expect(reply.send).toHaveBeenCalledWith(Buffer.from("pdf-bytes"));
    expect(reply.redirect).not.toHaveBeenCalled();
  });

  it("still 302s for un-parseable legacy URLs", async () => {
    vi.mocked(extractStorageKeyFromUrl).mockReturnValue(null);

    const controller = makeController({
      paymentProofUrl: "https://legacy.example/proof.png",
      event: { clientId: "c1" },
    });
    const reply = makeReply();

    await controller.paymentProof({ id: "reg-1" } as never, superAdmin, reply as never);

    expect(reply.redirect).toHaveBeenCalledWith("https://legacy.example/proof.png", 302);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("maps a storage 404 to NOT_FOUND", async () => {
    vi.mocked(extractStorageKeyFromUrl).mockReturnValue("proofs/gone.pdf");
    vi.mocked(getStorageProvider).mockReturnValue({
      download: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { code: 404 });
      }),
    } as never);

    const controller = makeController({
      paymentProofUrl: "https://storage/proofs/gone.pdf",
      event: { clientId: "c1" },
    });

    await expect(
      controller.paymentProof({ id: "reg-1" } as never, superAdmin, makeReply() as never),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s when no proof was uploaded", async () => {
    const controller = makeController({
      paymentProofUrl: null,
      event: { clientId: "c1" },
    });

    await expect(
      controller.paymentProof({ id: "reg-1" } as never, superAdmin, makeReply() as never),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

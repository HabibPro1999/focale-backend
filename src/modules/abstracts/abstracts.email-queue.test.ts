import { beforeEach, describe, expect, it, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { Prisma } from "@/generated/prisma/client.js";
import { queueAbstractEmail } from "./abstracts.email-queue.js";
import { queueEmail } from "@modules/email/email-queue.service.js";

vi.mock("@modules/email/email-queue.service.js", () => ({
  queueEmail: vi.fn(),
}));

function prismaUniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.2.0",
    meta,
  });
}

function mockAbstract() {
  return {
    id: "abstract-1",
    eventId: "event-1",
    authorFirstName: "Ada",
    authorLastName: "Lovelace",
    authorAffiliation: "Analytical Institute",
    authorEmail: "ada@example.com",
    content: { mode: "FREE_TEXT", title: "Analytical Engine" },
    status: "SUBMITTED",
    requestedType: "POSTER",
    finalType: null,
    code: null,
    editToken: "token-1",
    linkBaseUrl: "https://events.example.com",
    event: {
      id: "event-1",
      name: "Test Congress",
      slug: "test-congress",
      clientId: "client-1",
    },
  };
}

describe("queueAbstractEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips duplicate submission acknowledgements when the DB dedupe index wins a race", async () => {
    prismaMock.abstract.findUnique.mockResolvedValue(mockAbstract() as never);
    prismaMock.abstractConfig.findUnique.mockResolvedValue(null);
    prismaMock.emailLog.create.mockRejectedValueOnce(
      prismaUniqueError({
        target: "email_logs_abstract_submission_ack_active_key",
      }) as never,
    );

    await expect(
      queueAbstractEmail({
        trigger: "ABSTRACT_SUBMISSION_ACK",
        abstractId: "abstract-1",
      }),
    ).resolves.toBeUndefined();
    expect(queueEmail).not.toHaveBeenCalled();
  });
});

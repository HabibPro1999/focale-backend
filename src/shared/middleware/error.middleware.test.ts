import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@/generated/prisma/client.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { errorHandler } from "./error.middleware.js";

function mockReply() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply as unknown as FastifyReply & {
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

function mockRequest(): FastifyRequest {
  return { id: "request-1" } as FastifyRequest;
}

function prismaError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.2.0",
    meta,
  });
}

describe("errorHandler", () => {
  it("handles Prisma unique errors with array target metadata", () => {
    const reply = mockReply();

    errorHandler(
      prismaError({ target: ["email", "formId"] }),
      mockRequest(),
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
        field: "email, formId",
      }),
    );
  });

  it("does not throw when Prisma target metadata is a string", () => {
    const reply = mockReply();

    expect(() =>
      errorHandler(
        prismaError({ target: "registrations_email_key" }),
        mockRequest(),
        reply,
      ),
    ).not.toThrow();

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCodes.CONFLICT,
        field: "",
      }),
    );
  });

  it("handles Cockroach adapter field metadata", () => {
    const reply = mockReply();

    errorHandler(
      prismaError({
        driverAdapterError: {
          cause: { constraint: { fields: ["email", "form_id"] } },
        },
      }),
      mockRequest(),
      reply,
    );

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCodes.REGISTRATION_ALREADY_EXISTS,
        field: "email, form_id",
      }),
    );
  });
});

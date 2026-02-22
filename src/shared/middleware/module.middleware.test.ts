import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  createMockUser,
  createMockSuperAdmin,
  createMockClientAdmin,
  createMockClient,
} from "../../../tests/helpers/factories.js";
import { requireModule } from "./auth.middleware.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// Mock the clients module
vi.mock("@clients", () => ({
  getClientById: vi.fn(),
}));

// Import the mocked function
import { getClientById } from "@clients";
const getClientByIdMock = vi.mocked(getClientById);

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock Fastify request object for testing middleware.
 */
function createMockRequest(
  overrides: Partial<FastifyRequest> = {},
): FastifyRequest {
  return {
    headers: {},
    user: undefined,
    ...overrides,
  } as FastifyRequest;
}

/**
 * Creates a mock Fastify reply object for testing middleware.
 */
function createMockReply(): FastifyReply {
  return {} as FastifyReply;
}

// ============================================================================
// requireModule Tests
// ============================================================================

describe("requireModule", () => {
  const mockReply = createMockReply();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw 401 when user is not authenticated", async () => {
    const request = createMockRequest();
    const middleware = requireModule("pricing");

    await expect(middleware(request, mockReply)).rejects.toThrow(AppError);
    await expect(middleware(request, mockReply)).rejects.toMatchObject({
      statusCode: 401,
      code: ErrorCodes.UNAUTHORIZED,
      message: "Authentication required",
    });
  });

  it("should bypass check for super admin users", async () => {
    const superAdmin = createMockSuperAdmin({ id: "admin-123" });
    const request = createMockRequest({ user: superAdmin });
    const middleware = requireModule("pricing");

    // Should not throw
    await expect(middleware(request, mockReply)).resolves.toBeUndefined();

    // Should not call getClientById for super admin
    expect(getClientByIdMock).not.toHaveBeenCalled();
  });

  it("should throw 403 when client admin has no clientId", async () => {
    const clientAdminWithoutClient = createMockUser({
      id: "user-123",
      role: 1, // CLIENT_ADMIN
      clientId: null,
    });
    const request = createMockRequest({ user: clientAdminWithoutClient });
    const middleware = requireModule("pricing");

    await expect(middleware(request, mockReply)).rejects.toThrow(AppError);
    await expect(middleware(request, mockReply)).rejects.toMatchObject({
      statusCode: 403,
      code: ErrorCodes.MODULE_NOT_ENABLED,
      message: "Module access denied",
    });
  });

  it("should throw 403 when client is not found", async () => {
    const clientAdmin = createMockClientAdmin("client-123", {
      id: "user-123",
    });
    const request = createMockRequest({ user: clientAdmin });
    const middleware = requireModule("pricing");

    getClientByIdMock.mockResolvedValue(null);

    await expect(middleware(request, mockReply)).rejects.toThrow(AppError);
    await expect(middleware(request, mockReply)).rejects.toMatchObject({
      statusCode: 403,
      code: ErrorCodes.FORBIDDEN,
      message: "Client not found",
    });

    expect(getClientByIdMock).toHaveBeenCalledWith("client-123");
  });

  it("should throw 403 when client admin does not have required module", async () => {
    const clientAdmin = createMockClientAdmin("client-123", {
      id: "user-123",
    });
    const request = createMockRequest({ user: clientAdmin });
    const middleware = requireModule("pricing");

    const mockClient = createMockClient({
      id: "client-123",
      enabledModules: ["registrations", "emails"], // pricing not enabled
    });
    getClientByIdMock.mockResolvedValue(mockClient);

    await expect(middleware(request, mockReply)).rejects.toThrow(AppError);
    await expect(middleware(request, mockReply)).rejects.toMatchObject({
      statusCode: 403,
      code: ErrorCodes.MODULE_NOT_ENABLED,
      message: "This feature is not enabled for your organization",
    });

    expect(getClientByIdMock).toHaveBeenCalledWith("client-123");
  });

  it("should pass when client admin has required module", async () => {
    const clientAdmin = createMockClientAdmin("client-123", {
      id: "user-123",
    });
    const request = createMockRequest({ user: clientAdmin });
    const middleware = requireModule("pricing");

    const mockClient = createMockClient({
      id: "client-123",
      enabledModules: ["pricing", "registrations", "emails"],
    });
    getClientByIdMock.mockResolvedValue(mockClient);

    // Should not throw
    await expect(middleware(request, mockReply)).resolves.toBeUndefined();

    expect(getClientByIdMock).toHaveBeenCalledWith("client-123");
  });

  it("should pass when client admin has ANY of the required modules", async () => {
    const clientAdmin = createMockClientAdmin("client-123", {
      id: "user-123",
    });
    const request = createMockRequest({ user: clientAdmin });
    // Require pricing OR sponsorships
    const middleware = requireModule("pricing", "sponsorships");

    const mockClient = createMockClient({
      id: "client-123",
      enabledModules: ["registrations", "sponsorships", "emails"], // has sponsorships
    });
    getClientByIdMock.mockResolvedValue(mockClient);

    // Should not throw - has one of the required modules
    await expect(middleware(request, mockReply)).resolves.toBeUndefined();

    expect(getClientByIdMock).toHaveBeenCalledWith("client-123");
  });

  it("should throw 403 when client admin has NONE of the required modules", async () => {
    const clientAdmin = createMockClientAdmin("client-123", {
      id: "user-123",
    });
    const request = createMockRequest({ user: clientAdmin });
    // Require pricing OR sponsorships
    const middleware = requireModule("pricing", "sponsorships");

    const mockClient = createMockClient({
      id: "client-123",
      enabledModules: ["registrations", "emails"], // has neither
    });
    getClientByIdMock.mockResolvedValue(mockClient);

    await expect(middleware(request, mockReply)).rejects.toThrow(AppError);
    await expect(middleware(request, mockReply)).rejects.toMatchObject({
      statusCode: 403,
      code: ErrorCodes.MODULE_NOT_ENABLED,
    });

    expect(getClientByIdMock).toHaveBeenCalledWith("client-123");
  });
});

import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@app/contracts";
import { AppException, badRequest, conflict, forbidden, notFound, orNotFound } from "./app-exception";

describe("coded error factories", () => {
  it.each([
    [notFound, 404, ErrorCodes.NOT_FOUND],
    [badRequest, 400, ErrorCodes.VALIDATION_ERROR],
    [conflict, 409, ErrorCodes.CONFLICT],
  ] as const)("preserves AppException status and default code %#", (factory, status, code) => {
    const error = factory("Exact message");
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code, statusCode: status, message: "Exact message" });
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({ code, message: "Exact message" });
  });

  it.each([undefined, null, false, 0, "", { failures: ["unchanged"] }])("preserves explicit code and details %j", (details) => {
    const error = badRequest("Exact message", { code: ErrorCodes.BAD_REQUEST, details });
    expect(error.code).toBe(ErrorCodes.BAD_REQUEST);
    expect(error.details).toBe(details);
    expect(error.getResponse()).toEqual({
      code: ErrorCodes.BAD_REQUEST, message: "Exact message",
      ...(details !== undefined ? { details } : {}),
    });
  });

  it.each([notFound, conflict])("preserves a non-default domain code %#", (factory) => {
    const error = factory("Domain message", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    expect(error.getResponse()).toEqual({ code: ErrorCodes.REGISTRATION_NOT_FOUND, message: "Domain message" });
  });

  it.each([null, undefined])("orNotFound rejects %s with the supplied domain code/details", (value) => {
    expect(() => orNotFound(value, "Missing registration", {
      code: ErrorCodes.REGISTRATION_NOT_FOUND, details: { id: "r1" },
    })).toThrow(expect.objectContaining({
      code: ErrorCodes.REGISTRATION_NOT_FOUND, statusCode: 404, details: { id: "r1" },
    }));
  });

  it.each([false, 0, "", { id: "r1" }])("orNotFound returns the same non-null value %j", (value) => {
    expect(orNotFound(value, "Missing")).toBe(value);
  });

  it("keeps forbidden's throwing API and default response", () => {
    expect(forbidden).toThrow(expect.objectContaining({
      code: ErrorCodes.FORBIDDEN, statusCode: 403, message: "Insufficient permissions",
    }));
  });
});

import { vi } from "vitest";

/**
 * Mock the Resend SDK.
 * `emails.send` resolves a success envelope by default; `webhooks.verify`
 * returns whatever the test configures (and may be made to throw).
 */
export const resendMock = {
  send: vi.fn().mockResolvedValue({ data: { id: "mock-resend-id" }, error: null }),
  verify: vi.fn(),
};

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => resendMock.send(...args) };
    webhooks = { verify: (...args: unknown[]) => resendMock.verify(...args) };
    constructor(_key?: string) {}
  },
}));

/** Reset the Resend mock between tests. */
export function resetResendMock(): void {
  resendMock.send
    .mockReset()
    .mockResolvedValue({ data: { id: "mock-resend-id" }, error: null });
  resendMock.verify.mockReset();
}

/** Simulate a Resend send failure (errors are returned, not thrown). */
export function mockResendFailure(
  error: { name: string; message: string } = {
    name: "application_error",
    message: "Resend API error",
  },
): void {
  resendMock.send.mockResolvedValue({ data: null, error });
}

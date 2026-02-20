import { vi } from "vitest";

/**
 * Mock SendGrid mail service.
 * Provides mocked methods for sending emails.
 */
export const sendGridMock = {
  setApiKey: vi.fn(),
  send: vi.fn().mockResolvedValue([
    {
      statusCode: 202,
      headers: {
        "x-message-id": "mock-message-id-123",
      },
      body: "",
    },
    {},
  ]),
};

// Mock the @sendgrid/mail module
vi.mock("@sendgrid/mail", () => ({
  default: sendGridMock,
  setApiKey: sendGridMock.setApiKey,
  send: sendGridMock.send,
}));

/**
 * Helper to reset SendGrid mock between tests.
 */
export function resetSendGridMock(): void {
  sendGridMock.setApiKey.mockClear();
  sendGridMock.send.mockClear();
  sendGridMock.send.mockResolvedValue([
    {
      statusCode: 202,
      headers: {
        "x-message-id": "mock-message-id-123",
      },
      body: "",
    },
    {},
  ]);
}

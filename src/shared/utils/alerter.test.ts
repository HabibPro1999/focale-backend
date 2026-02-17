import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type AlertPayload } from "./alerter.js";

// Mock config module to control alertWebhookUrl per test
const mockConfig = {
  alertWebhookUrl: undefined as string | undefined,
};
vi.mock("@config/app.config.js", () => ({
  config: mockConfig,
}));

// Import after mock
const { sendAlert } = await import("./alerter.js");

describe("Alerter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    mockConfig.alertWebhookUrl = undefined;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("sendAlert", () => {
    it("should be no-op when ALERT_WEBHOOK_URL is not configured", async () => {
      mockConfig.alertWebhookUrl = undefined;

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "info",
      };

      sendAlert(payload);

      // Give async operation time to complete (if it runs)
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should send webhook request successfully", async () => {
      mockConfig.alertWebhookUrl = "https://hooks.slack.com/test";

      fetchSpy.mockResolvedValue(
        new Response(null, { status: 200, statusText: "OK" }),
      );

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "error",
        context: { foo: "bar" },
      };

      sendAlert(payload);

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://hooks.slack.com/test",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );
    });

    it("should handle fetch failure gracefully", async () => {
      mockConfig.alertWebhookUrl = "https://hooks.slack.com/test";

      fetchSpy.mockRejectedValue(new Error("Network error"));

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "critical",
      };

      // Should not throw
      expect(() => sendAlert(payload)).not.toThrow();

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalled();
    });

    it("should format webhook body correctly for all severity levels", async () => {
      mockConfig.alertWebhookUrl = "https://hooks.slack.com/test";

      const severities: AlertPayload["severity"][] = [
        "info",
        "warning",
        "error",
        "critical",
      ];
      const expectedLabels = ["[INFO]", "[WARNING]", "[ERROR]", "[CRITICAL]"];

      for (let i = 0; i < severities.length; i++) {
        fetchSpy.mockClear();
        fetchSpy.mockResolvedValue(
          new Response(null, { status: 200, statusText: "OK" }),
        );

        const payload: AlertPayload = {
          title: "Test Alert",
          message: "Test message",
          severity: severities[i],
        };

        sendAlert(payload);

        // Give async operation time to complete
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(fetchSpy).toHaveBeenCalledWith(
          "https://hooks.slack.com/test",
          expect.objectContaining({
            body: expect.stringContaining(expectedLabels[i]),
          }),
        );
      }
    });

    it("should include context in webhook body when provided", async () => {
      mockConfig.alertWebhookUrl = "https://hooks.slack.com/test";

      fetchSpy.mockResolvedValue(
        new Response(null, { status: 200, statusText: "OK" }),
      );

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "error",
        context: { userId: "123", action: "login" },
      };

      sendAlert(payload);

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      const callArgs = fetchSpy.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1]?.body as string);

      expect(requestBody.text).toContain("Context:");
      expect(requestBody.text).toContain("userId");
      expect(requestBody.text).toContain("123");
    });

    it("should handle non-200 response status", async () => {
      mockConfig.alertWebhookUrl = "https://hooks.slack.com/test";

      fetchSpy.mockResolvedValue(
        new Response(null, {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "error",
      };

      // Should not throw
      expect(() => sendAlert(payload)).not.toThrow();

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).toHaveBeenCalled();
    });
  });
});

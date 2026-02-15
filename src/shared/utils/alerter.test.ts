import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendAlert, type AlertPayload } from "./alerter.js";
import { config } from "@config/app.config.js";

describe("Alerter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("sendAlert", () => {
    it("should be no-op when ALERT_WEBHOOK_URL is not configured", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Temporarily set to undefined
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = undefined;

      const payload: AlertPayload = {
        title: "Test Alert",
        message: "Test message",
        severity: "info",
      };

      sendAlert(payload);

      // Give async operation time to complete (if it runs)
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fetchSpy).not.toHaveBeenCalled();

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });

    it("should send webhook request successfully", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Set webhook URL
      (config as { alertWebhookUrl?: string }).alertWebhookUrl =
        "https://hooks.slack.com/test";

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

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });

    it("should handle fetch failure gracefully", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Set webhook URL
      (config as { alertWebhookUrl?: string }).alertWebhookUrl =
        "https://hooks.slack.com/test";

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

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });

    it("should format webhook body correctly for all severity levels", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Set webhook URL
      (config as { alertWebhookUrl?: string }).alertWebhookUrl =
        "https://hooks.slack.com/test";

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

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });

    it("should include context in webhook body when provided", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Set webhook URL
      (config as { alertWebhookUrl?: string }).alertWebhookUrl =
        "https://hooks.slack.com/test";

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

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });

    it("should handle non-200 response status", async () => {
      // Save original value
      const originalUrl = config.alertWebhookUrl;

      // Set webhook URL
      (config as { alertWebhookUrl?: string }).alertWebhookUrl =
        "https://hooks.slack.com/test";

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

      // Restore original value
      (config as { alertWebhookUrl?: string }).alertWebhookUrl = originalUrl;
    });
  });
});

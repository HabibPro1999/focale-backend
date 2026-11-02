import { describe, expect, it } from "vitest";
import { emailFailureStatus } from "./email-queue";

// The retry rule markEmailFailed writes and the worker reports. The SQL of
// both branches is covered by tests/db/email-failure-boundaries.db.test.ts.
describe("emailFailureStatus", () => {
  it.each([
    [1, 3, "QUEUED"],
    [3, 3, "QUEUED"],
    [4, 3, "FAILED"],
    // A send-now row: attempt 1 of max_retries 0.
    [1, 0, "FAILED"],
  ] as const)(
    "attempt %i of max_retries %i → %s",
    (attemptCount, maxRetries, status) => {
      expect(emailFailureStatus(attemptCount, maxRetries)).toBe(status);
    },
  );
});

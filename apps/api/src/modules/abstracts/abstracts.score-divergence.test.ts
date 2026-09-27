import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";
import {
  assignReviewersTxn, findAbstractBasic, findActiveMembershipUserIds,
  findScoredReviewScores, getReviewerAssignmentConfig,
} from "@app/db";

vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  assignReviewersTxn: vi.fn(),
  findAbstractBasic: vi.fn(),
  findActiveMembershipUserIds: vi.fn(),
  findScoredReviewScores: vi.fn(),
  getReviewerAssignmentConfig: vi.fn(),
  insertAuditLog: vi.fn(),
}));

import { AbstractsCommitteeService } from "./abstracts.committee.service";
import type { UsersService } from "../identity/users.service";
import type { CommitteeInviteService } from "./abstracts.committee-invite.service";
import type { CommitteeEmailsService } from "./abstracts.committee-emails";

const service = new AbstractsCommitteeService(
  {} as UsersService, {} as CommitteeInviteService, {} as CommitteeEmailsService,
);
const reviewerIds = ["reviewer-1", "reviewer-2", "extra-reviewer"];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findAbstractBasic).mockResolvedValue({ id: "abstract", eventId: "event", status: "UNDER_REVIEW" });
  vi.mocked(findActiveMembershipUserIds).mockResolvedValue(reviewerIds);
  vi.mocked(assignReviewersTxn).mockResolvedValue({ id: "abstract", status: "UNDER_REVIEW" });
});

describe("extra-reviewer gate remains distinct from score-divergence notifications", () => {
  // In contrast, DB notifications require at least two scores and a positive spread even at threshold zero.
  it.each([
    { label: "no scores, zero threshold", scores: [], threshold: 0, allowed: true },
    { label: "one score, zero threshold", scores: [10], threshold: 0, allowed: true },
    { label: "equal scores, zero threshold", scores: [10, 10], threshold: 0, allowed: true },
    { label: "distinct scores, zero threshold", scores: [10, 11], threshold: 0, allowed: true },
    { label: "no scores, positive threshold", scores: [], threshold: 6, allowed: false },
    { label: "one score, positive threshold", scores: [10], threshold: 6, allowed: false },
    { label: "equal scores, positive threshold", scores: [10, 10], threshold: 6, allowed: false },
    { label: "spread below threshold", scores: [10, 15], threshold: 6, allowed: false },
    { label: "spread at threshold", scores: [10, 16], threshold: 6, allowed: true },
    { label: "spread above threshold", scores: [10, 17], threshold: 6, allowed: true },
  ])("$label", async ({ scores, threshold, allowed }) => {
    vi.mocked(findScoredReviewScores).mockResolvedValue(scores);
    vi.mocked(getReviewerAssignmentConfig).mockResolvedValue({
      reviewersPerAbstract: 2, divergenceThreshold: threshold, distributeByTheme: false,
    });
    const result = service.assignReviewers("event", "abstract", { reviewerIds }, "admin");
    if (allowed) {
      await expect(result).resolves.toEqual({ abstractId: "abstract", status: "UNDER_REVIEW", reviewerIds });
      expect(assignReviewersTxn).toHaveBeenCalledWith({
        eventId: "event", abstractId: "abstract", reviewerIds, currentStatus: "UNDER_REVIEW",
      });
    } else {
      await expect(result).rejects.toMatchObject({
        statusCode: 400, code: ErrorCodes.VALIDATION_ERROR,
        message: "Extra reviewers can only be assigned after a score divergence alert",
      });
      expect(assignReviewersTxn).not.toHaveBeenCalled();
    }
  });
});

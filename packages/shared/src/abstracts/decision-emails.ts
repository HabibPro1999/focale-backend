/**
 * Author emails an abstract decision sends.
 *
 * Every decision sends its decision email (accepted, rejected, or the generic
 * one for any other final status). The committee's comments follow when the
 * event shares them with authors and at least one review has a comment. An
 * accepted abstract also gets the final-file request when final-file upload
 * is on. The dedupe keys are scoped to the decision by the abstract's
 * updatedAt before it, so a decision made again after a reopen sends again.
 */

export type AbstractDecisionEmailTrigger =
  | "ABSTRACT_ACCEPTED"
  | "ABSTRACT_REJECTED"
  | "ABSTRACT_DECISION"
  | "ABSTRACT_COMMITTEE_COMMENTS"
  | "ABSTRACT_FINAL_FILE_REQUEST";

export interface AbstractDecisionEmail {
  /** The email.abstract outbox payload. */
  payload: {
    trigger: AbstractDecisionEmailTrigger;
    abstractId: string;
    extraContext?: { committeeComments: string };
  };
  dedupeKey: string;
}

export interface AbstractDecisionEmailInput {
  abstractId: string;
  /** The abstract's status after the decision. */
  status: string;
  /** The abstract's updatedAt before the decision. */
  decidedFrom: Date;
  /** The event's abstract config; absent config sends the decision email only. */
  config:
    | {
        commentsEnabled: boolean;
        commentsSentToAuthor: boolean;
        finalFileUploadEnabled: boolean;
      }
    | null
    | undefined;
  /** The abstract's active reviews, oldest first. */
  reviews: readonly { name: string | null; comment: string | null }[];
}

/** The emails to enqueue for a decision, in sending order. */
export function selectDecisionEmails(input: AbstractDecisionEmailInput): AbstractDecisionEmail[] {
  const { abstractId, status, config } = input;
  const decisionTrigger =
    status === "ACCEPTED"
      ? "ABSTRACT_ACCEPTED"
      : status === "REJECTED"
        ? "ABSTRACT_REJECTED"
        : "ABSTRACT_DECISION";
  const decisionScope = `${abstractId}:${input.decidedFrom.getTime()}`;

  const emails: AbstractDecisionEmail[] = [
    {
      payload: { trigger: decisionTrigger, abstractId },
      dedupeKey: `email:abstract:${decisionTrigger}:${decisionScope}`,
    },
  ];

  if (config?.commentsEnabled && config.commentsSentToAuthor) {
    const committeeComments = collectCommitteeComments(input.reviews);
    if (committeeComments) {
      emails.push({
        payload: {
          trigger: "ABSTRACT_COMMITTEE_COMMENTS",
          abstractId,
          extraContext: { committeeComments },
        },
        dedupeKey: `email:abstract:ABSTRACT_COMMITTEE_COMMENTS:${decisionScope}`,
      });
    }
  }

  if (status === "ACCEPTED" && config?.finalFileUploadEnabled) {
    emails.push({
      payload: { trigger: "ABSTRACT_FINAL_FILE_REQUEST", abstractId },
      dedupeKey: `email:abstract:ABSTRACT_FINAL_FILE_REQUEST:${decisionScope}`,
    });
  }

  return emails;
}

/**
 * The comments sent to the author: "<reviewer>: <comment>" per review with a
 * comment, blank-line separated. A reviewer without a name is "Reviewer <n>",
 * n being the review's position among all of them.
 */
export function collectCommitteeComments(
  reviews: readonly { name: string | null; comment: string | null }[],
): string {
  return reviews
    .map((review, index) => {
      const comment = review.comment?.trim();
      if (!comment) return null;
      const label = review.name?.trim() || `Reviewer ${index + 1}`;
      return `${label}: ${comment}`;
    })
    .filter((c): c is string => Boolean(c))
    .join("\n\n");
}

import { describe, expect, it } from "vitest";
import {
  collectCommitteeComments,
  selectDecisionEmails,
  type AbstractDecisionEmailInput,
} from "./decision-emails";

const decidedFrom = new Date(Date.UTC(2030, 0, 1, 10, 0, 0, 123));
const scope = `abs-1:${decidedFrom.getTime()}`;
const allOn = { commentsEnabled: true, commentsSentToAuthor: true, finalFileUploadEnabled: true };
const reviews = [
  { name: "Dr Alice", comment: "  Clear methods. " },
  { name: "Dr Bob", comment: null },
  { name: "  ", comment: "Shorten the intro." },
];
const select = (input: Partial<AbstractDecisionEmailInput>) =>
  selectDecisionEmails({
    abstractId: "abs-1",
    status: "ACCEPTED",
    decidedFrom,
    config: allOn,
    reviews,
    ...input,
  });
const triggers = (input: Partial<AbstractDecisionEmailInput>) =>
  select(input).map((email) => email.payload.trigger);

describe("selectDecisionEmails", () => {
  it("accepted: decision, committee comments, final-file request, keyed to the decision", () => {
    expect(select({})).toEqual([
      {
        payload: { trigger: "ABSTRACT_ACCEPTED", abstractId: "abs-1" },
        dedupeKey: `email:abstract:ABSTRACT_ACCEPTED:${scope}`,
      },
      {
        payload: {
          trigger: "ABSTRACT_COMMITTEE_COMMENTS",
          abstractId: "abs-1",
          extraContext: {
            committeeComments: "Dr Alice: Clear methods.\n\nReviewer 3: Shorten the intro.",
          },
        },
        dedupeKey: `email:abstract:ABSTRACT_COMMITTEE_COMMENTS:${scope}`,
      },
      {
        payload: { trigger: "ABSTRACT_FINAL_FILE_REQUEST", abstractId: "abs-1" },
        dedupeKey: `email:abstract:ABSTRACT_FINAL_FILE_REQUEST:${scope}`,
      },
    ]);
  });

  it("picks the decision email from the status", () => {
    expect(triggers({ status: "REJECTED", config: null })).toEqual(["ABSTRACT_REJECTED"]);
    expect(triggers({ status: "PENDING", config: null })).toEqual(["ABSTRACT_DECISION"]);
  });

  it("requests the final file only for an accepted abstract with upload on", () => {
    const noComments = { ...allOn, commentsEnabled: false };
    expect(triggers({ status: "REJECTED", config: noComments })).toEqual(["ABSTRACT_REJECTED"]);
    expect(triggers({ status: "PENDING", config: noComments })).toEqual(["ABSTRACT_DECISION"]);
    expect(triggers({ config: { ...noComments, finalFileUploadEnabled: false } })).toEqual([
      "ABSTRACT_ACCEPTED",
    ]);
  });

  it("sends committee comments only when enabled, shared with authors, and not empty", () => {
    expect(triggers({ status: "REJECTED" })).toEqual([
      "ABSTRACT_REJECTED",
      "ABSTRACT_COMMITTEE_COMMENTS",
    ]);
    const rejected = { status: "REJECTED" };
    expect(triggers({ ...rejected, config: { ...allOn, commentsEnabled: false } })).toEqual([
      "ABSTRACT_REJECTED",
    ]);
    expect(triggers({ ...rejected, config: { ...allOn, commentsSentToAuthor: false } })).toEqual([
      "ABSTRACT_REJECTED",
    ]);
    expect(
      triggers({ ...rejected, reviews: [{ name: "Dr Bob", comment: "   " }, { name: null, comment: null }] }),
    ).toEqual(["ABSTRACT_REJECTED"]);
    expect(triggers({ ...rejected, reviews: [] })).toEqual(["ABSTRACT_REJECTED"]);
  });

  it("sends the decision email alone without a config row", () => {
    expect(triggers({ config: undefined })).toEqual(["ABSTRACT_ACCEPTED"]);
  });

  it("scopes every dedupe key to the abstract's updatedAt before the decision", () => {
    const later = new Date(decidedFrom.getTime() + 1);
    const keys = select({ decidedFrom: later }).map((email) => email.dedupeKey);
    expect(keys.every((key) => key.endsWith(`:abs-1:${later.getTime()}`))).toBe(true);
  });
});

describe("collectCommitteeComments", () => {
  it("labels each comment with its reviewer, numbering unnamed reviewers by position", () => {
    expect(
      collectCommitteeComments([
        { name: null, comment: "First." },
        { name: " Dr Alice ", comment: " Second. " },
        { name: "", comment: "Third." },
      ]),
    ).toBe("Reviewer 1: First.\n\nDr Alice: Second.\n\nReviewer 3: Third.");
  });

  it("is empty when no review has a comment", () => {
    expect(collectCommitteeComments([{ name: "Dr Bob", comment: " " }])).toBe("");
  });
});

import { pgEnum } from "drizzle-orm/pg-core";

// All 19 pg enums, value lists EXACT per _schema_full.sql / prisma schema.
// pgEnum name = the live Postgres type name (PascalCase, as created by Prisma).

export const eventStatus = pgEnum("EventStatus", ["CLOSED", "OPEN", "ARCHIVED"]);

export const formType = pgEnum("FormType", ["REGISTRATION", "SPONSOR"]);

export const sponsorshipStatus = pgEnum("SponsorshipStatus", [
  "PENDING",
  "USED",
  "CANCELLED",
]);

export const accessType = pgEnum("AccessType", [
  "WORKSHOP",
  "DINNER",
  "SESSION",
  "NETWORKING",
  "ACCOMMODATION",
  "TRANSPORT",
  "OTHER",
  "ADDON",
]);

export const paymentStatus = pgEnum("PaymentStatus", [
  "PENDING",
  "VERIFYING",
  "PARTIAL",
  "PAID",
  "SPONSORED",
  "WAIVED",
  "REFUNDED",
]);

export const paymentMethod = pgEnum("PaymentMethod", [
  "BANK_TRANSFER",
  "ONLINE",
  "CASH",
  "LAB_SPONSORSHIP",
]);

export const registrationRole = pgEnum("RegistrationRole", [
  "PARTICIPANT",
  "SPEAKER",
  "MODERATOR",
  "ORGANIZER",
  "INVITED",
]);

export const transactionType = pgEnum("TransactionType", [
  "PAYMENT",
  "REFUND",
  "WAIVER",
  "ADJUSTMENT",
]);

export const emailTemplateCategory = pgEnum("EmailTemplateCategory", [
  "AUTOMATIC",
  "MANUAL",
]);

export const automaticEmailTrigger = pgEnum("AutomaticEmailTrigger", [
  "REGISTRATION_CREATED",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_CONFIRMED",
  "SPONSORSHIP_BATCH_SUBMITTED",
  "SPONSORSHIP_LINKED",
  "SPONSORSHIP_APPLIED",
  "SPONSORSHIP_PARTIAL",
  "CERTIFICATE_SENT",
]);

export const emailStatus = pgEnum("EmailStatus", [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
  "BOUNCED",
  "DROPPED",
  "FAILED",
  "SKIPPED",
]);

export const abstractSubmissionMode = pgEnum("AbstractSubmissionMode", [
  "FREE_TEXT",
  "STRUCTURED",
]);

export const abstractBookOrder = pgEnum("AbstractBookOrder", [
  "BY_CODE",
  "BY_THEME",
  "BY_SUBMISSION_ORDER",
]);

export const abstractRequestedType = pgEnum("AbstractRequestedType", [
  "ORAL_COMMUNICATION",
  "POSTER",
]);

export const abstractFinalType = pgEnum("AbstractFinalType", [
  "CONFERENCE",
  "ORAL_COMMUNICATION",
  "POSTER",
]);

export const abstractStatus = pgEnum("AbstractStatus", [
  "SUBMITTED",
  "UNDER_REVIEW",
  "REVIEW_COMPLETE",
  "ACCEPTED",
  "REJECTED",
  "PENDING",
]);

export const abstractFileKind = pgEnum("AbstractFileKind", ["PDF", "PPT", "PPTX"]);

export const abstractEmailTrigger = pgEnum("AbstractEmailTrigger", [
  "ABSTRACT_SUBMISSION_ACK",
  "ABSTRACT_EDIT_ACK",
  "ABSTRACT_DECISION",
  "ABSTRACT_ACCEPTED",
  "ABSTRACT_REJECTED",
  "ABSTRACT_COMMITTEE_INVITE",
  "ABSTRACT_COMMITTEE_COMMENTS",
  "ABSTRACT_SCORE_DIVERGENCE",
  "ABSTRACT_FINAL_FILE_REQUEST",
]);

export const abstractBookJobStatus = pgEnum("AbstractBookJobStatus", [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);

/**
 * Abstracts queries. The code lives in `./abstracts/`, one module per area;
 * this barrel is the public surface (re-exported by `@app/db`). Names are
 * listed explicitly so helpers the modules share among themselves (row
 * loaders, the review aggregate) stay internal. Every type a public row type
 * refers to is exported too, so declaration emit in the apps can name it.
 */

export {
  enqueueAbstractEmailOutboxEvent,
  findEventClientId,
  findEventName,
  type AbstractConfigRow,
  type AbstractEmailOutboxPayload,
  type AbstractMembershipRow,
  type AbstractReviewRow,
  type AbstractRevisionRow,
  type AbstractRow,
  type AbstractThemeInsert,
  type AbstractThemeRow,
  type AdminAbstractDetailRow,
  type AdminAbstractRow,
  type AdminReviewRow,
  type ReviewerAbstractRow,
  type ReviewerRef,
  type ThemeRef,
  type ThemeWithSort,
} from "./abstracts/shared";

export {
  countAbstractsByEvent,
  getOrCreateAbstractConfig,
  updateAbstractConfig,
} from "./abstracts/config";

export {
  countCodedAbstractsByTheme,
  findThemeWithEventId,
  insertTheme,
  listThemesByConfigId,
  softDeleteThemeRow,
  updateThemeRow,
} from "./abstracts/themes";

export {
  editAbstractTxn,
  findAbstractForEdit,
  findAbstractForFinalFile,
  findAbstractForToken,
  findAbstractThemeIds,
  findActiveThemeIds,
  findDuplicateAuthorEmail,
  findEventConfigForSubmit,
  findPublicConfigData,
  findRegistrationEventId,
  submitAbstractTxn,
  updateAbstractFinalFileTxn,
  type AbstractForEdit,
  type AbstractForFinalFile,
  type AbstractForToken,
  type EditAbstractResult,
  type EditAbstractTxnParams,
  type EventConfigForSubmit,
  type FinalFileUpdate,
  type PublicConfigData,
  type SubmitAbstractTxnParams,
} from "./abstracts/public";

export {
  buildAdminAbstractsWhere,
  getAbstractsExportPlan,
  getAdminAbstractDetail,
  iterateAbstractsForExport,
  listAdminAbstracts,
  type AbstractsExportPlan,
  type ListAdminAbstractsFilters,
} from "./abstracts/admin-reads";

export {
  countAccessibleAbstracts,
  deactivateCommitteeMembershipTxn,
  findAbstractMembership,
  findCommitteeInviteTarget,
  findCommitteeUserClientIds,
  getActiveThemeIdsForEvent,
  getAssignedAbstractRow,
  getCommitteeProfile,
  listActiveReviewerThemeIds,
  listAssignedAbstracts,
  listCommitteeMembers,
  setReviewerThemesTxn,
  upsertCommitteeMembership,
  type CommitteeInviteTarget,
  type CommitteeMemberDto,
  type CommitteeProfileEvent,
} from "./abstracts/committee";

export {
  assignReviewersTxn,
  findAbstractBasic,
  findActiveMembershipUserIds,
  findScoredReviewScores,
  getCommitteeConfig,
  getReviewerAssignmentConfig,
  type AssignReviewersResult,
} from "./abstracts/assignment";

export {
  findAbstractForReview,
  reviewAbstractTxn,
  type AbstractForReview,
  type ReviewAbstractResult,
} from "./abstracts/reviews";

export {
  finalizeAbstractTxn,
  markAbstractPresentedTxn,
  reopenAbstractTxn,
  type FinalizeResult,
  type PresentedResult,
  type ReopenResult,
} from "./abstracts/decisions";

export {
  ABSTRACT_BOOK_LEASE_MS,
  abstractBookQueue,
  completeAbstractBookJob,
  enqueueAbstractBookJob,
  failAbstractBookJob,
  getAbstractBookJob,
  getAbstractBookQueueHealth,
  listAbstractBookJobs,
  loadClaimedAbstractBookJobs,
  type AbstractBookJobRow,
  type AbstractBookQueueHealth,
  type EnqueueBookJobResult,
} from "./abstracts/book-queue";

export {
  getAbstractBookData,
  type AbstractBookConfig,
  type AbstractBookData,
} from "./abstracts/book-data";

export {
  findSkippedAbstractEmails,
  getAbstractForEmailContext,
  type AbstractEmailTrigger,
  type AbstractForEmailContext,
  type SkippedAbstractEmailRow,
} from "./abstracts/email";

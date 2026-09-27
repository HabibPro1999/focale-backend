// Compatibility entry point for sponsorship queries. Internal helpers stay in
// their leaves.
export type {
  SponsorshipRow,
  SponsorshipUsageRow,
  SponsorshipBatchRow,
  SponsorshipClientGate,
  ExistingUsageRow,
} from "./sponsorships/shared";
export {
  buildSponsorshipWhere,
  listSponsorships,
  getSponsorshipById,
  getSponsorshipByCode,
  getPendingSponsorships,
  getRegistrationCoverage,
  getLinkedSponsorships,
} from "./sponsorships/read";
export type {
  SponsorshipListItem,
  SponsorshipWithUsages,
  SponsorshipWithBatch,
  PendingSponsorshipRow,
  RegistrationCoverageRow,
  LinkedSponsorshipItem,
} from "./sponsorships/read";
export {
  findActiveEventAccess,
  getEventPricingForBatch,
  findEventForBatch,
  findSponsorFormById,
  getActiveSponsorForm,
  getFormSchema,
  findRegistrationsForBatch,
  insertSponsorshipBatch,
  insertSponsorship,
  sponsorshipCodeExists,
} from "./sponsorships/batch";
export type {
  AccessItemForOverlap,
  EventPricingForBatch,
  EventForBatch,
  RegistrationForBatch,
} from "./sponsorships/batch";
export {
  findSponsorshipForMutation,
  updateSponsorshipRow,
  deleteSponsorshipRow,
  findSponsorshipForLink,
  findRegistrationForLink,
  findUsage,
  insertUsage,
  deleteUsage,
  casSetSponsorshipUsed,
  updateUsageAmount,
  enqueueSponsorshipEmailOutbox,
} from "./sponsorships/usages";
export type {
  SponsorshipForMutation,
  SponsorshipForLink,
  RegistrationForLink,
  SponsorshipEmailOutboxPayload,
} from "./sponsorships/usages";
export {
  getRegistrationForSponsorship,
  searchRegistrantsForSponsorship,
} from "./sponsorships/registrants";
export type {
  RegistrationRouteGuard,
  RegistrantSearchRow,
} from "./sponsorships/registrants";

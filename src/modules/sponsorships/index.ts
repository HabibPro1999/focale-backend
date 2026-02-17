// ============================================================================
// Sponsorships Module - Barrel Export
// Only exports what is consumed outside the module.
// ============================================================================

// Service functions (external consumers: registrations, server)
export { cleanupSponsorshipsForRegistration } from "./sponsorships-linking.service.js";

// Utility functions (external consumer: pricing)
export { calculateApplicableAmount } from "./sponsorships.utils.js";

// Utility types (external consumer: pricing)
export type { SponsorshipForCalculation } from "./sponsorships.utils.js";
export type { RegistrationForCalculation } from "./sponsorships.utils.js";

// Routes (external consumer: server)
export {
  sponsorshipsRoutes,
  sponsorshipDetailRoutes,
  registrationSponsorshipsRoutes,
} from "./sponsorships.routes.js";

export {
  sponsorshipsPublicRoutes,
  sponsorshipsPublicBySlugRoutes,
} from "./sponsorships.public.routes.js";

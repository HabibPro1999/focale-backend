// ============================================================================
// Registrations Module - Barrel Export
// Only what external modules consume. Internal consumers use direct file imports.
// ============================================================================

// Service functions consumed externally
export { getRegistrationById } from "./registrations.service.js";
export { searchRegistrantsForSponsorship } from "./registrations.service.js";
export { buildRegistrationWhere } from "./registrations.service.js";
export { recomputeSponsorshipAmount } from "./registrations.service.js";

// Schema consumed externally (certificates module)
export { RegistrationRoleSchema } from "./registrations.schema.js";

// Routes
export { registrationsRoutes } from "./registrations.routes.js";
export {
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "./registrations.public.routes.js";

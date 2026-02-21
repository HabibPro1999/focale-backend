// ============================================================================
// Registrations Module - Barrel Export
// ============================================================================

// Service functions (external consumers exist)
export { getRegistrationById } from "./registration-crud.service.js";
export { searchRegistrantsForSponsorship } from "./registration-query.service.js";

// Routes
export { registrationsRoutes } from "./registrations.routes.js";
export {
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "./registrations.public.routes.js";

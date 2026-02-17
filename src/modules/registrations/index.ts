// ============================================================================
// Registrations Module - Barrel Export
// ============================================================================

// Service functions (external consumers exist)
export {
  getRegistrationById,
  searchRegistrantsForSponsorship,
} from "./registrations.service.js";

// Routes
export { registrationsRoutes } from "./registrations.routes.js";
export {
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "./registrations.public.routes.js";

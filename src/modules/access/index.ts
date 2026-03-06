// ============================================================================
// Access Module - Barrel Export
// ============================================================================

// Service functions (external: registrations, forms)
export {
  validateAccessDatesAgainstEvent,
  reserveAccessSpot,
  releaseAccessSpot,
} from "./access.service.js";

// Public-facing functions (external: registrations)
export { validateAccessSelections } from "./access-public.service.js";

// Schemas (external: registrations)
export { AccessSelectionSchema } from "./access.schema.js";

// Routes (external: server.ts)
export { accessRoutes } from "./access.routes.js";
export { accessPublicRoutes } from "./access.public.routes.js";

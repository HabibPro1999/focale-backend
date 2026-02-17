// ============================================================================
// Access Module - Barrel Export
// ============================================================================

// Service functions (external: registrations)
export {
  validateAccessSelections,
  reserveAccessSpot,
  releaseAccessSpot,
} from "./access.service.js";

// Schemas (external: registrations)
export { AccessSelectionSchema } from "./access.schema.js";

// Routes (external: server.ts)
export { accessRoutes } from "./access.routes.js";
export { accessPublicRoutes } from "./access.public.routes.js";

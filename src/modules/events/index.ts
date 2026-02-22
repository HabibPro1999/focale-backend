// Services (external consumers exist)
export {
  getEventById,
  getEventBySlug,
  eventExists,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "./events.service.js";

// Schemas — EventIdParamSchema re-exported for backward compat with external modules.
// External consumers (forms, access, registrations, etc.) import this.
// Will be removed when those modules are audited.
export { IdParamSchema as EventIdParamSchema } from "@shared/schemas/params.js";
export { EventSlugParamSchema } from "./events.schema.js";

// Routes
export { eventsRoutes } from "./events.routes.js";

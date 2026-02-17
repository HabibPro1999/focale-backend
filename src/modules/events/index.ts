// Services (external consumers exist)
export {
  getEventById,
  getEventBySlug,
  eventExists,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "./events.service.js";

// Schemas (external consumers exist)
export { EventIdParamSchema, EventSlugParamSchema } from "./events.schema.js";

// Routes
export { eventsRoutes } from "./events.routes.js";

// Services
export {
  getEventById,
  getEventBySlug,
  eventExists,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "./events.service.js";

// Schemas
export { EventIdParamSchema, EventSlugParamSchema } from "./events.schema.js";

// Routes
export { eventsRoutes } from "./events.routes.js";
export { eventsPublicRoutes } from "./events.public.routes.js";

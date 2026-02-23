// Services (external consumers exist)
export {
  getEventById,
  getEventBySlug,
  eventExists,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "./events.service.js";

export { EventSlugParamSchema } from "./events.schema.js";

// Routes
export { eventsRoutes } from "./events.routes.js";

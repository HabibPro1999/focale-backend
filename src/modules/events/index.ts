// Services
export {
  createEvent,
  getEventById,
  getEventBySlug,
  updateEvent,
  listEvents,
  deleteEvent,
  eventExists,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "./events.service.js";

// Schemas & Types
export {
  CreateEventSchema,
  UpdateEventSchema,
  ListEventsQuerySchema,
  EventIdParamSchema,
  EventSlugParamSchema,
  type CreateEventInput,
  type UpdateEventInput,
  type ListEventsQuery,
} from "./events.schema.js";

// Routes
export { eventsRoutes } from "./events.routes.js";

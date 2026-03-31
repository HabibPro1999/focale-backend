// ============================================================================
// Access Module - Barrel Export
// ============================================================================

// Service functions
export {
  createEventAccess,
  updateEventAccess,
  deleteEventAccess,
  listEventAccess,
  getEventAccessById,
  getAccessClientId,
  getGroupedAccess,
  validateAccessSelections,
  reserveAccessSpot,
  releaseAccessSpot,
} from './access.service.js';

// Schemas
export {
  AccessConditionSchema,
  AccessTypeSchema,
  ACCESS_TYPE_LABELS,
  CreateEventAccessSchema,
  UpdateEventAccessSchema,
  ListEventAccessQuerySchema,
  EventAccessIdParamSchema,
  EventIdParamSchema,
  TimeSlotSchema,
  DateGroupSchema,
  TypeGroupSchema, // Backward compatibility alias for DateGroupSchema
  GroupedAccessResponseSchema,
  AccessSelectionSchema,
  GetGroupedAccessBodySchema,
  ValidateAccessSelectionsBodySchema,
} from './access.schema.js';

// Types
export type {
  AccessType,
  AccessCondition,
  CreateEventAccessInput,
  UpdateEventAccessInput,
  AccessSelection,
  TimeSlot,
  DateGroup,
  TypeGroup, // Backward compatibility alias for DateGroup
  GroupedAccessResponse,
  GetGroupedAccessBody,
  ValidateAccessSelectionsBody,
} from './access.schema.js';

// Routes
export { accessRoutes } from './access.routes.js';
export { accessPublicRoutes } from './access.public.routes.js';

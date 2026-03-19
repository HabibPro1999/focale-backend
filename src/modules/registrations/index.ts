// ============================================================================
// Registrations Module - Barrel Export
// ============================================================================

// Service functions
export {
  createRegistration,
  createAdminRegistration,
  getRegistrationById,
  updateRegistration,
  confirmPayment,
  deleteRegistration,
  listRegistrations,
  getRegistrationClientId,
  registrationExists,
  // Self-service editing
  getRegistrationForEdit,
  editRegistrationPublic,
  // Table columns
  getRegistrationTableColumns,
  // Sponsorship search
  searchRegistrantsForSponsorship,
} from "./registrations.service.js";

// Service types
export type {
  GetRegistrationForEditResult,
  EditRegistrationPublicResult,
  RegistrationTableColumns,
} from "./registrations.service.js";

// Schemas
export {
  PaymentStatusSchema,
  PaymentMethodSchema,
  RegistrationRoleSchema,
  CreateRegistrationSchema,
  AdminCreateRegistrationSchema,
  UpdatePaymentSchema,
  UpdateRegistrationSchema,
  ListRegistrationsQuerySchema,
  RegistrationIdParamSchema,
  EventIdParamSchema,
  FormIdParamSchema,
  PriceBreakdownSchema,
  // Self-service editing schemas
  PublicEditRegistrationSchema,
  RegistrationIdPublicParamSchema,
  // Table column schemas
  TableColumnTypeSchema,
  TableColumnOptionSchema,
  TableColumnSchema,
  RegistrationColumnsResponseSchema,
  // Sponsorship search schemas
  SearchRegistrantsQuerySchema,
  RegistrantSearchResultSchema,
} from "./registrations.schema.js";

// Types
export type {
  PaymentStatus,
  PaymentMethod,
  RegistrationRole,
  CreateRegistrationInput,
  AdminCreateRegistrationInput,
  UpdateRegistrationInput,
  UpdatePaymentInput,
  ListRegistrationsQuery,
  PriceBreakdown,
  // Self-service editing types
  PublicEditRegistrationInput,
  // Table column types
  TableColumnType,
  TableColumnOption,
  TableColumn,
  RegistrationColumnsResponse,
  // Sponsorship search types
  SearchRegistrantsQuery,
  RegistrantSearchResult,
} from "./registrations.schema.js";

// Routes
export { registrationsRoutes } from "./registrations.routes.js";
export {
  registrationsPublicRoutes,
  registrationEditPublicRoutes,
} from "./registrations.public.routes.js";

// Services
export {
  createClient,
  getClientById,
  updateClient,
  listClients,
  deleteClient,
  clientExists,
} from "./clients.service.js";

// Schemas & Types
export {
  CreateClientSchema,
  UpdateClientSchema,
  ListClientsQuerySchema,
  ClientIdParamSchema,
  MODULE_IDS,
  ALL_MODULE_IDS,
  type CreateClientInput,
  type UpdateClientInput,
  type ListClientsQuery,
  type ModuleId,
} from "./clients.schema.js";

// Routes
export { clientsRoutes } from "./clients.routes.js";

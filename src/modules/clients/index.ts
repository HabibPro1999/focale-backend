// Routes
export { clientsRoutes } from "./clients.routes.js";

// Services
export {
  clientExists,
  getClientById,
  getClientByIdWithAdmin,
} from "./clients.service.js";

// Types
export type { ModuleId } from "./clients.schema.js";
export type { ClientWithAdmin } from "./clients.service.js";

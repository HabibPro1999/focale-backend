export { clientExists } from "./clients.service.js";
export { clientsRoutes } from "./clients.routes.js";
export {
  assertClientModuleEnabled,
  assertModuleEnabledForClient,
  CLIENT_MODULE_GATE_SELECT,
  CLIENT_MODULE_GATE_WITH_NAME_SELECT,
  isModuleEnabledForClient,
} from "./module-gates.js";
export {
  DEFAULT_ENABLED_MODULES,
  MODULE_IDS,
  normalizeEnabledModules,
  type ModuleId,
} from "./clients.schema.js";

// Only export what external modules actually consume.
// Internal consumers (routes, service) import directly from ./access.service.js etc.

export {
  validateAccessSelections,
  reserveAccessSpot,
  releaseAccessSpot,
  incrementPaidCount,
  decrementPaidCount,
  handleCapacityReached,
} from "./access.service.js";

export { AccessSelectionSchema } from "./access.schema.js";

export { accessRoutes } from "./access.routes.js";
export { accessPublicRoutes } from "./access.public.routes.js";

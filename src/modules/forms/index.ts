// Only export what external modules actually consume.
// Internal consumers (routes, service) import directly from ./forms.service.js etc.

export { getFormById } from "./forms.service.js";

export {
  validateFormData,
  sanitizeFormData,
  type FormSchema,
} from "./form-data-validator.js";

export { type FormField } from "./forms.schema.js";

export { formsRoutes } from "./forms.routes.js";
export { formsPublicRoutes } from "./forms.public.routes.js";

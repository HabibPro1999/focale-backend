// ============================================================================
// Certificates Module - Barrel Export
// ============================================================================

// Service functions
export {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
  getTemplateClientId,
} from "./certificates.service.js";

// Schemas
export {
  CertificateZoneSchema,
  RegistrationRoleSchema,
  CreateCertificateTemplateSchema,
  UpdateCertificateTemplateSchema,
  EventIdParamSchema,
  TemplateIdParamSchema,
} from "./certificates.schema.js";

// Types
export type {
  CertificateZone,
  CreateCertificateTemplateInput,
  UpdateCertificateTemplateInput,
} from "./certificates.schema.js";

// Routes
export { certificatesRoutes } from "./certificates.routes.js";

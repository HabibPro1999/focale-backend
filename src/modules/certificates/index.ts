// Routes
export { certificatesRoutes } from "./certificates.routes.js";

// PDF generation
export {
  generateCertificateAttachments,
  isEligibleForCertificate,
  type ImageCache,
  type CertificateTemplateData,
  type RegistrationForCertificate,
} from "./certificate-pdf.service.js";

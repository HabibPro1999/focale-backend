// Declarative tenant scoping for admin routes (plan 5.4).
export {
  AccessItemScoped,
  BadgeTemplateScoped,
  CertificateTemplateScoped,
  ClientScoped,
  EmailTemplateScoped,
  EventScoped,
  FormScoped,
  RegistrationScoped,
  requireTenantScope,
  ScopedClient,
  ScopedEvent,
  SponsorshipScoped,
  TENANT_SCOPE,
  TenantScopeGuard,
} from "./tenant-scope";

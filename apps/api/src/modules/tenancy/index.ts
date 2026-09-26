// Declarative tenant scoping for admin routes (plan 5.4).
export {
  EmailTemplateScoped,
  EventScoped,
  RegistrationScoped,
  ScopedClient,
  ScopedEvent,
  SponsorshipScoped,
  TENANT_SCOPE,
  TenantScopeGuard,
  type TenantScope,
  type TenantScopeKind,
  type TenantScopeOptions,
  type TenantScopeRule,
} from "./tenant-scope";

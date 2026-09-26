import {
  applyDecorators,
  BadRequestException,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { Reflector } from "@nestjs/core";
import { ErrorCodes, type ModuleId } from "@app/contracts";
import {
  getAccessItemTenantScope,
  getCertificateTemplateTenantScope,
  getClientTenantScope,
  getEmailTemplateTenantScope,
  getEventTenantScope,
  getFormTenantScope,
  getRegistrationTenantScope,
  getSponsorshipTenantScope,
  type ScopedClientRow,
  type ScopedEventRow,
} from "@app/db";
import { canAccessClient, type AuthUser } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { assertEventWritable } from "../events/events.service";

// ============================================================================
// Declarative tenant scoping (plan 5.4).
//
// `@EventScoped()`, `@RegistrationScoped()`, `@SponsorshipScoped()`,
// `@EmailTemplateScoped()`, `@AccessItemScoped()`,
// `@CertificateTemplateScoped()`, `@FormScoped()` and `@ClientScoped()` put a
// guard on a route that loads the resource named by a route param, its event
// and the event's client in one query (a client route loads the client), then
// refuses, in this order:
//   400  the route's `@Param()` DTO rejects the params (the same check the
//        global pipe makes; guards run before pipes);
//   404  the resource does not exist;
//   403  the caller cannot access the owning client (`canAccessClient`);
//   400  (email template, write) the template belongs to no event;
//   400  (write) the event is archived;
//   403  (module) the client is inactive (CLIENT_INACTIVE) or has not
//        enabled the module (MODULE_DISABLED).
// The loaded scope is attached to the request; `@ScopedEvent()` and
// `@ScopedClient()` read it in the handler.
//
// Class-level `@Auth()` runs first (Nest runs controller guards before route
// guards); without a user this guard answers 401.
//
// A route that names its event or client in the body or the query calls
// `requireTenantScope()` in the handler instead: the same read, checks, order
// and codes, after the pipes have validated that id.
// ============================================================================

export const TENANT_SCOPE = "tenantScope";

export type TenantScopeKind =
  | "event"
  | "registration"
  | "sponsorship"
  | "emailTemplate"
  | "accessItem"
  | "certificateTemplate"
  | "form"
  | "client";

export interface TenantScopeOptions {
  /** Module(s) the client must have enabled; the client must also be active. */
  module?: ModuleId | readonly ModuleId[];
  /** The route changes the event's data: an archived event refuses it. */
  write?: boolean;
  /** Route param holding the resource id (default `id`; `eventId` for an event, `templateId` for an email template). */
  param?: string;
}

export interface FormScopeOptions extends TenantScopeOptions {
  /** Also require the module of the form's type: sponsorships for a SPONSOR form, registrations otherwise. */
  moduleOfFormType?: boolean;
}

/** What a scope decorator stores on the handler (read by the guard and the route-matrix test). */
export interface TenantScopeRule {
  kind: TenantScopeKind;
  param: string;
  modules: readonly ModuleId[];
  write: boolean;
  /** (form) The form's type adds its module: sponsorships for SPONSOR, registrations otherwise. */
  moduleOfFormType: boolean;
}

/**
 * What the guard attaches to the request: the event and its client; the
 * client alone on a client route; neither for an email template that belongs
 * to no event.
 */
export type EventScope = { event: ScopedEventRow; client: ScopedClientRow };
export type ClientScope = { event: null; client: ScopedClientRow };
export type TenantScope = EventScope | ClientScope | { event: null; client: null };

const DEFAULT_PARAM: Record<TenantScopeKind, string> = {
  event: "eventId",
  registration: "id",
  sponsorship: "id",
  emailTemplate: "templateId",
  accessItem: "id",
  certificateTemplate: "id",
  form: "id",
  client: "id",
};

function toRule(kind: TenantScopeKind, options: FormScopeOptions): TenantScopeRule {
  const modules =
    options.module === undefined
      ? []
      : typeof options.module === "string"
        ? [options.module]
        : [...options.module];
  return {
    kind,
    param: options.param ?? DEFAULT_PARAM[kind],
    modules,
    write: options.write ?? false,
    moduleOfFormType: options.moduleOfFormType ?? false,
  };
}

function scoped(kind: TenantScopeKind, options: FormScopeOptions) {
  return applyDecorators(
    SetMetadata(TENANT_SCOPE, toRule(kind, options)),
    UseGuards(TenantScopeGuard),
  );
}

/** Route on an event (`:eventId` by default). */
export function EventScoped(options: TenantScopeOptions = {}) {
  return scoped("event", options);
}

/** Route on a registration (`:id` by default); scoped through its event. */
export function RegistrationScoped(options: TenantScopeOptions = {}) {
  return scoped("registration", options);
}

/** Route on a sponsorship (`:id` by default); scoped through its event. */
export function SponsorshipScoped(options: TenantScopeOptions = {}) {
  return scoped("sponsorship", options);
}

/**
 * Route on an email template (`:templateId` by default). The caller must
 * reach both the template's client and its event's client. With `write`, the
 * template must belong to an event. Module gates apply when it has an event.
 */
export function EmailTemplateScoped(options: TenantScopeOptions = {}) {
  return scoped("emailTemplate", options);
}

/** Route on an event access item (`:id` by default); scoped through its event. */
export function AccessItemScoped(options: TenantScopeOptions = {}) {
  return scoped("accessItem", options);
}

/** Route on a certificate template (`:id` by default); scoped through its event. */
export function CertificateTemplateScoped(options: TenantScopeOptions = {}) {
  return scoped("certificateTemplate", options);
}

/**
 * Route on a form (`:id` by default); scoped through its event. With
 * `moduleOfFormType`, the form's type adds its module to the gate.
 */
export function FormScoped(options: FormScopeOptions = {}) {
  return scoped("form", options);
}

/**
 * Route on a client (`:id` by default): the client must exist (404) and be
 * the caller's (403). No event, so no archived check; module gates apply.
 */
export function ClientScoped(options: Omit<TenantScopeOptions, "write"> = {}) {
  return scoped("client", options);
}

type ScopedRequest = {
  user?: AuthUser;
  params?: Record<string, string | undefined>;
  tenantScope?: TenantScope;
};

function scopeOf(ctx: ExecutionContext): TenantScope {
  const scope = ctx.switchToHttp().getRequest<ScopedRequest>().tenantScope;
  if (!scope) {
    throw new InternalServerErrorException("Route has no tenant scope guard");
  }
  return scope;
}

/** The scoped event (id, clientId, status, slug). */
export const ScopedEvent = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ScopedEventRow => {
    const { event } = scopeOf(ctx);
    if (!event) throw new InternalServerErrorException("Route scope has no event");
    return event;
  },
);

/** The scoped event's client (id, active, enabledModules). */
export const ScopedClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ScopedClientRow => {
    const { client } = scopeOf(ctx);
    if (!client) throw new InternalServerErrorException("Route scope has no client");
    return client;
  },
);

const paramsPipe = new ZodValidationPipe();

/**
 * Validate the route params with the handler's whole-`@Param()` DTO, as the
 * global pipe would after the guards, so a malformed id keeps its 400.
 */
function validateRouteParams(ctx: ExecutionContext, params: unknown): void {
  const handler = ctx.getHandler();
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctx.getClass(), handler.name) ??
    {}) as Record<string, { index: number; data?: unknown }>;
  const types = (Reflect.getMetadata(
    "design:paramtypes",
    ctx.getClass().prototype as object,
    handler.name,
  ) ?? []) as unknown[];
  for (const [key, arg] of Object.entries(args)) {
    if (key.split(":")[0] !== String(RouteParamtypes.PARAM) || arg.data !== undefined) continue;
    paramsPipe.transform(params, {
      type: "param",
      metatype: types[arg.index] as never,
      data: undefined,
    });
  }
}

function notFound(kind: TenantScopeKind): never {
  switch (kind) {
    case "accessItem":
      throw new NotFoundException({
        code: ErrorCodes.ACCESS_NOT_FOUND,
        message: "Access item not found",
      });
    case "certificateTemplate":
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Certificate template not found",
      });
    case "form":
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Form not found" });
    case "client":
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Client not found" });
    case "event":
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Event not found" });
    case "registration":
      throw new NotFoundException({
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
        message: "Registration not found",
      });
    case "sponsorship":
      throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: "Sponsorship not found" });
    case "emailTemplate":
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Email template not found",
      });
  }
}

function forbidden(): never {
  throw new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    message: "Insufficient permissions",
  });
}

/** Resources owned by an event: one read each, resource → event → client. */
const EVENT_OWNED_READS: Record<
  Exclude<TenantScopeKind, "client" | "form" | "emailTemplate">,
  (id: string) => Promise<EventScope | null>
> = {
  event: (id) => getEventTenantScope(id),
  registration: (id) => getRegistrationTenantScope(id),
  sponsorship: (id) => getSponsorshipTenantScope(id),
  accessItem: (id) => getAccessItemTenantScope(id),
  certificateTemplate: (id) => getCertificateTemplateTenantScope(id),
};

type LoadedScope = { scope: TenantScope; modules: readonly ModuleId[] };

async function loadScope(rule: TenantScopeRule, id: string, user: AuthUser): Promise<LoadedScope> {
  const modules = rule.modules;
  if (rule.kind === "client") {
    const found = await getClientTenantScope(id);
    if (!found) notFound(rule.kind);
    if (!canAccessClient(user, found.client.id)) forbidden();
    return { scope: { event: null, client: found.client }, modules };
  }
  if (rule.kind === "form") {
    const found = await getFormTenantScope(id);
    if (!found) notFound(rule.kind);
    if (!canAccessClient(user, found.event.clientId)) forbidden();
    const typeModule: ModuleId = found.form.type === "SPONSOR" ? "sponsorships" : "registrations";
    return {
      scope: { event: found.event, client: found.client },
      modules: rule.moduleOfFormType && !modules.includes(typeModule) ? [...modules, typeModule] : modules,
    };
  }
  if (rule.kind === "emailTemplate") {
    const found = await getEmailTemplateTenantScope(id);
    if (!found) notFound(rule.kind);
    if (
      !canAccessClient(user, found.template.clientId) ||
      (found.event !== null && !canAccessClient(user, found.event.clientId))
    ) {
      forbidden();
    }
    if (rule.write && found.template.eventId === null) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Email template is not event-scoped",
      });
    }
    if (found.template.eventId !== null && (found.event === null || found.client === null)) {
      notFound("event");
    }
    return {
      scope:
        found.event === null || found.client === null
          ? { event: null, client: null }
          : { event: found.event, client: found.client },
      modules,
    };
  }
  const found = await EVENT_OWNED_READS[rule.kind](id);
  if (!found) notFound(rule.kind);
  if (!canAccessClient(user, found.event.clientId)) forbidden();
  return { scope: { event: found.event, client: found.client }, modules };
}

/** Load the scope and refuse in the documented order; the guard and `requireTenantScope` share it. */
async function checkScope(rule: TenantScopeRule, id: string, user: AuthUser): Promise<TenantScope> {
  const { scope, modules } = await loadScope(rule, id, user);
  if (rule.write && scope.event !== null) assertEventWritable(scope.event);
  // A client-level email template has no client here: no module to check.
  if (scope.client !== null) {
    for (const moduleId of modules) {
      assertModuleEnabledForClient(scope.client, moduleId);
    }
  }
  return scope;
}

/**
 * The guard's check for an event or client id the route takes from its body
 * or query (known only after validation): same read, refusal order and codes.
 * Call it first thing in the handler.
 */
export function requireTenantScope(
  user: AuthUser,
  kind: "event",
  id: string,
  options?: TenantScopeOptions,
): Promise<EventScope>;
export function requireTenantScope(
  user: AuthUser,
  kind: "client",
  id: string,
  options?: Omit<TenantScopeOptions, "write">,
): Promise<ClientScope>;
export function requireTenantScope(
  user: AuthUser,
  kind: "event" | "client",
  id: string,
  options: TenantScopeOptions = {},
): Promise<TenantScope> {
  return checkScope(toRule(kind, options), id, user);
}

@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<TenantScopeRule | undefined>(TENANT_SCOPE, ctx.getHandler());
    if (!rule) {
      throw new InternalServerErrorException("Tenant scope guard without a scope rule");
    }
    const req = ctx.switchToHttp().getRequest<ScopedRequest>();
    if (!req.user) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: "Authentication required",
      });
    }
    validateRouteParams(ctx, req.params);
    const id = req.params?.[rule.param];
    if (typeof id !== "string") {
      throw new InternalServerErrorException(`Route has no :${rule.param} param`);
    }

    req.tenantScope = await checkScope(rule, id, req.user);
    return true;
  }
}

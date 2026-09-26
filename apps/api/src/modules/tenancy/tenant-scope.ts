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
  getEmailTemplateTenantScope,
  getEventTenantScope,
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
// `@EventScoped()`, `@RegistrationScoped()`, `@SponsorshipScoped()` and
// `@EmailTemplateScoped()` put a guard on a route that loads the resource
// named by a route param, its event and the event's client in one query, then
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
// ============================================================================

export const TENANT_SCOPE = "tenantScope";

export type TenantScopeKind = "event" | "registration" | "sponsorship" | "emailTemplate";

export interface TenantScopeOptions {
  /** Module(s) the client must have enabled; the client must also be active. */
  module?: ModuleId | readonly ModuleId[];
  /** The route changes the event's data: an archived event refuses it. */
  write?: boolean;
  /** Route param holding the resource id (defaults: eventId, id, id, templateId). */
  param?: string;
}

/** What a scope decorator stores on the handler (read by the guard and the route-matrix test). */
export interface TenantScopeRule {
  kind: TenantScopeKind;
  param: string;
  modules: readonly ModuleId[];
  write: boolean;
}

/**
 * What the guard attaches to the request: the event and its client, or
 * neither for an email template that belongs to no event.
 */
export type TenantScope =
  | { event: ScopedEventRow; client: ScopedClientRow }
  | { event: null; client: null };

const DEFAULT_PARAM: Record<TenantScopeKind, string> = {
  event: "eventId",
  registration: "id",
  sponsorship: "id",
  emailTemplate: "templateId",
};

function scoped(kind: TenantScopeKind, options: TenantScopeOptions) {
  const modules =
    options.module === undefined
      ? []
      : typeof options.module === "string"
        ? [options.module]
        : [...options.module];
  const rule: TenantScopeRule = {
    kind,
    param: options.param ?? DEFAULT_PARAM[kind],
    modules,
    write: options.write ?? false,
  };
  return applyDecorators(SetMetadata(TENANT_SCOPE, rule), UseGuards(TenantScopeGuard));
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

async function loadScope(rule: TenantScopeRule, id: string, user: AuthUser): Promise<TenantScope> {
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
    return found.event === null || found.client === null
      ? { event: null, client: null }
      : { event: found.event, client: found.client };
  }
  const found =
    rule.kind === "event"
      ? await getEventTenantScope(id)
      : rule.kind === "registration"
        ? await getRegistrationTenantScope(id)
        : await getSponsorshipTenantScope(id);
  if (!found) notFound(rule.kind);
  if (!canAccessClient(user, found.event.clientId)) forbidden();
  return { event: found.event, client: found.client };
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

    const scope = await loadScope(rule, id, req.user);
    // A client-level email template has no event: no event state or module to check.
    if (scope.event !== null) {
      if (rule.write) assertEventWritable(scope.event);
      for (const moduleId of rule.modules) {
        assertModuleEnabledForClient(scope.client, moduleId);
      }
    }
    req.tenantScope = scope;
    return true;
  }
}

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ROLE_KEY } from "../../core/auth/auth.decorator";
import { AuthGuard } from "../../core/auth/auth.guard";
import type { AuthUser } from "../../core/auth/user-cache";
import { RegistrationEditLinkController, RegistrationsController } from "./registrations.controller";
import type { RegistrationsService } from "./registrations.service";

const clientAdmin = { id: "admin-1", role: 1, clientId: "c1" } as AuthUser;
const otherTenantAdmin = { id: "admin-2", role: 1, clientId: "c2" } as AuthUser;
const superAdmin = { id: "root", role: 0, clientId: null } as AuthUser;

function makeController(clientId: string | null) {
  const service = {
    getRegistrationClientId: vi.fn(async () => clientId),
    issueSelfEditLink: vi.fn(async () => ({ url: "https://forms.example/ev/registration/r1/tok" })),
  };
  const controller = new RegistrationEditLinkController(
    service as unknown as RegistrationsService,
  );
  return { controller, service };
}

describe("GET /api/registrations/:id/edit-link", () => {
  it("returns the link and passes the actor and IP for the audit entry", async () => {
    const { controller, service } = makeController("c1");
    const res = await controller.editLink({ id: "r1" }, clientAdmin, "10.0.0.1");
    expect(res).toEqual({ url: "https://forms.example/ev/registration/r1/tok" });
    expect(service.issueSelfEditLink).toHaveBeenCalledWith("r1", "admin-1", "10.0.0.1");
  });

  it("lets a super admin fetch any tenant's link", async () => {
    const { controller, service } = makeController("c9");
    await controller.editLink({ id: "r1" }, superAdmin, "10.0.0.1");
    expect(service.issueSelfEditLink).toHaveBeenCalledWith("r1", "root", "10.0.0.1");
  });

  it("404 for an unknown registration, without issuing or auditing", async () => {
    const { controller, service } = makeController(null);
    await expect(controller.editLink({ id: "r1" }, clientAdmin, "ip")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(service.issueSelfEditLink).not.toHaveBeenCalled();
  });

  it("403 for another tenant's registration (same as the detail route), without issuing", async () => {
    const { controller, service } = makeController("c1");
    await expect(
      controller.editLink({ id: "r1" }, otherTenantAdmin, "ip"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(service.issueSelfEditLink).not.toHaveBeenCalled();
  });

  it("uses the same guard and role metadata as the admin detail route, and is not cacheable", () => {
    const guards = (target: object) => Reflect.getMetadata("__guards__", target) as unknown[];
    const role = (target: object) => Reflect.getMetadata(ROLE_KEY, target) as unknown;
    expect(guards(RegistrationEditLinkController)).toEqual([AuthGuard]);
    expect(guards(RegistrationsController)).toEqual([AuthGuard]);
    expect(role(RegistrationEditLinkController)).toBe(role(RegistrationsController));
    // No method-level role override on either route.
    expect(role(RegistrationEditLinkController.prototype.editLink)).toBeUndefined();
    expect(role(RegistrationsController.prototype.getById)).toBeUndefined();
    const headers = Reflect.getMetadata(
      "__headers__",
      RegistrationEditLinkController.prototype.editLink,
    ) as { name: string; value: string }[];
    expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
  });
});

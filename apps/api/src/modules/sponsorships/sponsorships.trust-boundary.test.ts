import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AuthGuard } from "../../core/auth/auth.guard";
import { AccessService } from "../access/access.service";
import {
  RegistrationSponsorshipsController,
  SponsorshipDetailController,
  SponsorshipsListController,
} from "./sponsorships.controller";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";
import { SponsorshipsPublicController } from "./sponsorships.public.controller";
import { SponsorshipsPublicService } from "./sponsorships.public.service";

// Plan 5.7: the anonymous sponsor form cannot reach an admin operation
// (link/unlink by an admin, coverage edit, cancel, delete). The public
// controller injects the public service only, and the public files import
// neither the admin service nor the settlement primitives behind those
// operations.

/** The files the anonymous routes execute, besides @app/db and shared helpers. */
const PUBLIC_FILES = [
  "sponsorships.public.controller.ts",
  "sponsorships.public.service.ts",
  "sponsorships.settlement.ts",
];

/** @app/db functions only an admin operation may call. */
const ADMIN_ONLY_DB = [
  "changeSponsorshipCoverageTxn",
  "releaseSponsorshipTxn",
  "unlinkSponsorshipFromRegistrationTxn",
  "deleteSponsorshipRow",
  "updateSponsorshipRow",
  "lockSponsorshipForUpdate",
  "findSponsorshipForMutation",
  "findSponsorshipForLink",
  "getSponsorshipByCode",
];

function imports(file: string): Array<{ from: string; names: string[] }> {
  const source = readFileSync(resolve(__dirname, file), "utf8");
  const found: Array<{ from: string; names: string[] }> = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+"([^"]+)"/g)) {
    const names = (match[1].match(/[A-Za-z_$][\w$]*/g) ?? []).filter((name) => name !== "type");
    found.push({ from: match[2], names });
  }
  return found;
}

function methodNames(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype).filter((name) => name !== "constructor");
}

describe("sponsorships trust boundary (plan 5.7)", () => {
  it("the anonymous controller injects the public service only", () => {
    expect(Reflect.getMetadata("design:paramtypes", SponsorshipsPublicController)).toEqual([
      SponsorshipsPublicService,
    ]);
    expect(Reflect.getMetadata("design:paramtypes", SponsorshipsPublicService)).toEqual([AccessService]);
    const adminMethods = new Set(methodNames(SponsorshipsAdminService));
    expect(methodNames(SponsorshipsPublicService).filter((name) => adminMethods.has(name))).toEqual([]);
  });

  it("the public files import neither the admin service nor the admin-only settlement primitives", () => {
    for (const file of PUBLIC_FILES) {
      const found = imports(file);
      expect(found.length, file).toBeGreaterThan(0);
      for (const { from, names } of found) {
        expect(from, file).not.toMatch(/sponsorships\.(admin\.service|controller)$/);
        if (from === "@app/db") {
          expect(names.filter((name) => ADMIN_ONLY_DB.includes(name)), file).toEqual([]);
        }
      }
    }
  });

  it("the public routes keep their throttles and stay anonymous", () => {
    const throttle = (method: keyof SponsorshipsPublicController) => {
      const handler = SponsorshipsPublicController.prototype[method];
      return {
        limit: Reflect.getMetadata("THROTTLER:LIMITdefault", handler),
        ttl: Reflect.getMetadata("THROTTLER:TTLdefault", handler),
        guards: Reflect.getMetadata(GUARDS_METADATA, handler),
      };
    };
    expect(throttle("createByEventId")).toEqual({ limit: 5, ttl: 60_000, guards: undefined });
    expect(throttle("createBySlug")).toEqual({ limit: 5, ttl: 60_000, guards: undefined });
    expect(throttle("searchRegistrants")).toEqual({ limit: 10, ttl: 60_000, guards: undefined });
    expect(Reflect.getMetadata(GUARDS_METADATA, SponsorshipsPublicController)).toBeUndefined();
  });

  it("every admin controller injects the admin service behind AuthGuard", () => {
    for (const controller of [
      SponsorshipsListController,
      SponsorshipDetailController,
      RegistrationSponsorshipsController,
    ]) {
      expect(Reflect.getMetadata("design:paramtypes", controller), controller.name).toEqual([
        SponsorshipsAdminService,
      ]);
      expect(Reflect.getMetadata(GUARDS_METADATA, controller), controller.name).toContain(AuthGuard);
    }
  });
});

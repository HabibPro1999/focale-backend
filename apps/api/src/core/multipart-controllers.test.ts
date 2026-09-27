import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, UserRole } from "@app/contracts";
import type { AuthUser } from "./auth/user-cache";
import type { MultipartRequest } from "./multipart";

const db = vi.hoisted(() => ({ findClientModuleState: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));

import { EventsController } from "../modules/events/events.controller";
import { EventsService } from "../modules/events/events.service";
import { CertificatesController } from "../modules/certificates/certificates.controller";
import { CertificatesService } from "../modules/certificates/certificates.service";
import { RegistrationEditPublicController } from "../modules/registrations/registrations.public.controller";
import { RegistrationSelfService } from "../modules/registrations/registration-self.service";
import { RegistrationPaymentProofService } from "../modules/registrations/registration-payment-proof.service";
import { AbstractsPublicController } from "../modules/abstracts/abstracts.public.controller";
import { AbstractsService } from "../modules/abstracts/abstracts.service";
import { AbstractsFinalFileService, MAX_FINAL_FILE_SIZE } from "../modules/abstracts/abstracts.final-file.service";

// Pin the upload boundaries before sharing their request plumbing. The services
// are stubs: these assertions concern the controller's reads, buffers and errors.
const user = { role: UserRole.CLIENT_ADMIN, clientId: "client-1" } as AuthUser;
const event = { id: "event-1", clientId: "client-1", status: "PUBLISHED" };
const token = "a".repeat(64);
const events = { getEventById: vi.fn(), uploadEventBanner: vi.fn() };
const certificates = { getTemplate: vi.fn(), uploadTemplateImage: vi.fn() };
const registrations = { verifyEditToken: vi.fn(), uploadPaymentProof: vi.fn() };
const finalFile = { uploadAbstractFinalFile: vi.fn() };
const banner = new EventsController(events as unknown as EventsService);
const certificate = new CertificatesController(certificates as unknown as CertificatesService);
const proof = new RegistrationEditPublicController(
  registrations as unknown as RegistrationSelfService,
  registrations as unknown as RegistrationPaymentProofService,
);
const abstract = new AbstractsPublicController({} as AbstractsService, finalFile as unknown as AbstractsFinalFileService);
const routes = [
  { name: "event banner", read: (req: MultipartRequest) => banner.uploadBanner(user, { id: "id" }, req), fileArgs: [], upload: events.uploadEventBanner, final: false },
  { name: "certificate image", read: (req: MultipartRequest) => certificate.uploadImage(user, { id: "id" }, req), fileArgs: [{ limits: { fileSize: 10 * 1024 * 1024 } }], upload: certificates.uploadTemplateImage, final: false },
  { name: "payment proof", read: (req: MultipartRequest) => proof.uploadPaymentProof({ registrationId: "id" }, {}, req, token), fileArgs: [], upload: registrations.uploadPaymentProof, final: false },
  { name: "abstract final file", read: (req: MultipartRequest) => abstract.uploadFinalFile({ id: "id" }, {}, req), fileArgs: [{ limits: { fileSize: MAX_FINAL_FILE_SIZE } }], upload: finalFile.uploadAbstractFinalFile, final: true },
];

function request(file: ReturnType<typeof vi.fn>): MultipartRequest {
  return { file, headers: { "x-abstract-token": token }, query: {}, ip: "127.0.0.1" } as unknown as MultipartRequest;
}
const missing = { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: "No file uploaded" };

beforeEach(() => {
  vi.resetAllMocks();
  events.getEventById.mockResolvedValue(event);
  certificates.getTemplate.mockResolvedValue({ event });
  db.findClientModuleState.mockResolvedValue({ active: true, enabledModules: ["certificates"] });
  registrations.verifyEditToken.mockResolvedValue(true);
  for (const upload of [events.uploadEventBanner, certificates.uploadTemplateImage, registrations.uploadPaymentProof]) {
    upload.mockImplementation(async (_id, file) => file);
  }
  finalFile.uploadAbstractFinalFile.mockImplementation(async (_id, _token, read) => read());
});

describe.each(routes)("$name multipart boundary", (route) => {
  it("keeps the file-size options and passes buffered bytes and metadata unchanged", async () => {
    const buffer = Buffer.from("file bytes");
    const toBuffer = vi.fn(async () => buffer);
    const file = vi.fn(async () => ({ filename: "unchanged.name", mimetype: "application/example", toBuffer }));
    const value = await route.read(request(file));
    expect(file).toHaveBeenCalledExactlyOnceWith(...route.fileArgs);
    expect(toBuffer).toHaveBeenCalledExactlyOnceWith();
    expect(value).toEqual({ buffer, filename: "unchanged.name", mimetype: "application/example" });
  });

  it("keeps the exact missing-file status, code and message", async () => {
    await expect(route.read(request(vi.fn(async () => undefined)))).rejects.toMatchObject(missing);
  });

  it.each([new Error("part read failed"), Object.assign(new Error("part too large"), { code: "FST_REQ_FILE_TOO_LARGE" })])(
    "keeps the file() rejection policy for %s",
    async (error) => {
      const result = route.read(request(vi.fn(async () => { throw error; })));
      if (route.final) await expect(result).rejects.toMatchObject(missing);
      else await expect(result).rejects.toBe(error);
    },
  );

  it("does not swallow a synchronous file() throw", async () => {
    const error = new Error("synchronous part read failed");
    await expect(route.read(request(vi.fn(() => { throw error; })))).rejects.toBe(error);
  });

  it("maps only the abstract buffer-size error to its existing 413", async () => {
    const error = Object.assign(new Error("buffer too large"), { code: "FST_REQ_FILE_TOO_LARGE" });
    const file = vi.fn(async () => ({ toBuffer: async () => { throw error; } }));
    const result = route.read(request(file));
    if (route.final) await expect(result).rejects.toMatchObject({ statusCode: 413, code: ErrorCodes.FILE_TOO_LARGE });
    else await expect(result).rejects.toBe(error);
  });

  it("propagates other buffering errors without replacing them", async () => {
    const error = new Error("buffer read failed");
    await expect(route.read(request(vi.fn(async () => ({ toBuffer: async () => { throw error; } }))))).rejects.toBe(error);
  });
});

it("payment-proof token verification completes before accessing the file", async () => {
  const file = vi.fn();
  registrations.verifyEditToken.mockResolvedValue(false);
  await expect(proof.uploadPaymentProof({ registrationId: "id" }, {}, request(file), token)).rejects.toMatchObject({ statusCode: 403, message: "Invalid edit token" });
  expect(file).not.toHaveBeenCalled();
});

it("abstract service rejection never invokes the file reader", async () => {
  const file = vi.fn();
  const error = new Error("abstract rejected");
  finalFile.uploadAbstractFinalFile.mockRejectedValue(error);
  await expect(abstract.uploadFinalFile({ id: "id" }, {}, request(file))).rejects.toBe(error);
  expect(file).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vitest";
import { BadRequestException, type HttpException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "./app-exception";
import { EventsController } from "../modules/events/events.controller";
import { CertificatesController } from "../modules/certificates/certificates.controller";
import { RegistrationEditPublicController } from "../modules/registrations/registrations.public.controller";
import { AbstractsPublicController } from "../modules/abstracts/abstracts.public.controller";
import {
  MAX_FINAL_FILE_SIZE,
  type FinalFileInput,
} from "../modules/abstracts/abstracts.final-file.service";

// Pins each upload route's multipart handling: the file() call, the
// missing-file error, and which read failures are mapped or rethrown.

type UploadRequest = Parameters<EventsController["uploadBanner"]>[1];
type Part = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};

const EDIT_TOKEN = "a".repeat(64);
const upload = vi.fn(async (_id: string, file: FinalFileInput) => file);

function makeRequest(file: () => Promise<Part | undefined>): UploadRequest {
  return {
    file,
    headers: { "x-abstract-token": EDIT_TOKEN },
    query: {},
    ip: "127.0.0.1",
  } as unknown as UploadRequest;
}

const routes = [
  {
    name: "event banner",
    fileSize: undefined,
    missingFileClass: BadRequestException,
    run: (req: UploadRequest) =>
      new EventsController({ uploadEventBanner: upload } as never).uploadBanner(
        { id: "event" },
        req,
      ),
  },
  {
    name: "certificate image",
    fileSize: 10 * 1024 * 1024,
    missingFileClass: BadRequestException,
    run: (req: UploadRequest) =>
      new CertificatesController({
        uploadTemplateImage: upload,
      } as never).uploadImage({ id: "certificate" }, req),
  },
  {
    name: "payment proof",
    fileSize: undefined,
    missingFileClass: AppException,
    run: (req: UploadRequest) =>
      new RegistrationEditPublicController(
        { verifyEditToken: async () => true } as never,
        { uploadPaymentProof: upload } as never,
        {} as never,
        {} as never,
      ).uploadPaymentProof(
        { registrationId: "registration" },
        {},
        req,
        EDIT_TOKEN,
      ),
  },
  {
    name: "abstract final file",
    fileSize: MAX_FINAL_FILE_SIZE,
    missingFileClass: BadRequestException,
    run: (req: UploadRequest) =>
      new AbstractsPublicController(
        {} as never,
        {
          uploadAbstractFinalFile: async (
            _id: string,
            _token: string,
            read: () => Promise<FinalFileInput>,
          ) => read(),
        } as never,
      ).uploadFinalFile({ id: "abstract" }, {}, req),
  },
];

describe.each(routes)("$name upload", (route) => {
  const isAbstract = route.name === "abstract final file";

  it("passes the route's file() options and forwards bytes and metadata", async () => {
    const buffer = Buffer.from("file");
    const file = vi.fn(async () => ({
      filename: "a.pdf",
      mimetype: "application/pdf",
      toBuffer: async () => buffer,
    }));

    await expect(route.run(makeRequest(file))).resolves.toEqual({
      buffer,
      filename: "a.pdf",
      mimetype: "application/pdf",
    });
    expect(file.mock.calls).toEqual(
      route.fileSize === undefined
        ? [[]]
        : [[{ limits: { fileSize: route.fileSize } }]],
    );
  });

  it("keeps the missing-file exception class and response body", async () => {
    const error = (await route
      .run(makeRequest(async () => undefined))
      .catch((caught: unknown) => caught)) as HttpException;

    expect(error.constructor).toBe(route.missingFileClass);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      route.name === "certificate image"
        ? { message: "No file uploaded", error: "Bad Request", statusCode: 400 }
        : { code: ErrorCodes.VALIDATION_ERROR, message: "No file uploaded" },
    );
  });

  it("maps a failing file() call to missing-file only for abstracts", async () => {
    const failure = Object.assign(new Error("file read failed"), {
      code: "FST_REQ_FILE_TOO_LARGE",
    });
    const result = route.run(
      makeRequest(async () => {
        throw failure;
      }),
    );

    if (isAbstract) {
      await expect(result).rejects.toMatchObject({
        response: { code: ErrorCodes.VALIDATION_ERROR, message: "No file uploaded" },
      });
    } else {
      await expect(result).rejects.toBe(failure);
    }
  });

  it("maps an oversized buffer to 413 only for abstracts", async () => {
    const failure = Object.assign(new Error("buffer too large"), {
      code: "FST_REQ_FILE_TOO_LARGE",
    });
    const result = route.run(
      makeRequest(async () => ({
        filename: "a",
        mimetype: "x",
        toBuffer: async () => {
          throw failure;
        },
      })),
    );

    if (isAbstract) {
      await expect(result).rejects.toMatchObject({
        statusCode: 413,
        code: ErrorCodes.FILE_TOO_LARGE,
        message: "Final file is too large. Maximum: 50MB.",
      });
    } else {
      await expect(result).rejects.toBe(failure);
    }
  });

  it("rethrows other buffer failures unchanged", async () => {
    const failure = new Error("buffer failed");
    const result = route.run(
      makeRequest(async () => ({
        filename: "a",
        mimetype: "x",
        toBuffer: async () => {
          throw failure;
        },
      })),
    );

    await expect(result).rejects.toBe(failure);
  });
});

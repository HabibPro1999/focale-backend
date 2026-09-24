import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import { ErrorCodes } from "@app/contracts";
import { getConfig as getAppConfig } from "../../core/config";
import { AbstractsService } from "./abstracts.service";
import {
  AbstractsFinalFileService,
  MAX_FINAL_FILE_SIZE,
  assertFinalFileContentLength,
  finalFileTooLarge,
  type FinalFileInput,
} from "./abstracts.final-file.service";
import { extractAbstractToken } from "./abstracts.token";
import {
  EventSlugParamDto,
  AbstractIdParamDto,
  AbstractTokenQueryDto,
  SubmitAbstractDto,
  EditAbstractDto,
} from "./abstracts.dto";

// @fastify/multipart augments the request with .file().
interface MultipartFile {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
}
type MultipartRequest = FastifyRequest & {
  file(opts?: { limits?: { fileSize?: number } }): Promise<MultipartFile | undefined>;
};

/** Reads the single final-file part; the multipart fileSize limit bounds a chunked body. */
async function readFinalFile(req: MultipartRequest): Promise<FinalFileInput> {
  const data = await req
    .file({ limits: { fileSize: MAX_FINAL_FILE_SIZE } })
    .catch(() => null);
  if (!data) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: "No file uploaded",
    });
  }
  let buffer: Buffer;
  try {
    buffer = await data.toBuffer();
  } catch (err) {
    // @fastify/multipart's RequestFileTooLargeError is not an HttpException (it would render as 500).
    if ((err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw finalFileTooLarge();
    }
    throw err;
  }
  return { buffer, filename: data.filename, mimetype: data.mimetype };
}

// Public rate limits (legacy publicRateLimits.abstracts*), validated by the
// config schema and resolved per request from the process config.
const abstractLimits = () => getAppConfig().security.publicAbstracts;
const windowMs = () => abstractLimits().windowMs;
const SUBMIT_THROTTLE = {
  default: { limit: () => abstractLimits().submitMax, ttl: windowMs },
};
const EDIT_THROTTLE = {
  default: { limit: () => abstractLimits().editMax, ttl: windowMs },
};
const READ_THROTTLE = {
  default: { limit: () => abstractLimits().readMax, ttl: windowMs },
};

@Controller("api/public")
export class AbstractsPublicController {
  constructor(
    private readonly abstracts: AbstractsService,
    private readonly finalFile: AbstractsFinalFileService,
  ) {}

  @Get("events/:slug/abstracts/config")
  @Throttle(READ_THROTTLE)
  getConfig(@Param() { slug }: EventSlugParamDto) {
    return this.abstracts.getPublicConfig(slug);
  }

  @Post("events/:slug/abstracts/submit")
  @HttpCode(201)
  @Throttle(SUBMIT_THROTTLE)
  submit(
    @Param() { slug }: EventSlugParamDto,
    @Body() body: SubmitAbstractDto,
    @Req() req: FastifyRequest,
  ) {
    return this.abstracts.submitAbstract(slug, body, req.ip);
  }

  @Get("abstracts/:id")
  @Throttle(READ_THROTTLE)
  getByToken(
    @Param() { id }: AbstractIdParamDto,
    @Query() _query: AbstractTokenQueryDto,
    @Req() req: FastifyRequest,
  ) {
    const token = extractAbstractToken(req);
    return this.abstracts.getAbstractByToken(id, token);
  }

  @Patch("abstracts/:id")
  @Throttle(EDIT_THROTTLE)
  edit(
    @Param() { id }: AbstractIdParamDto,
    @Query() _query: AbstractTokenQueryDto,
    @Body() body: EditAbstractDto,
    @Req() req: FastifyRequest,
  ) {
    const token = extractAbstractToken(req);
    return this.abstracts.editAbstract(id, token, body, req.ip);
  }

  @Post("abstracts/:id/final-file")
  @HttpCode(201)
  @Throttle(EDIT_THROTTLE)
  async uploadFinalFile(
    @Param() { id }: AbstractIdParamDto,
    @Query() _query: AbstractTokenQueryDto,
    @Req() req: MultipartRequest,
  ) {
    const token = extractAbstractToken(req);
    assertFinalFileContentLength(req.headers["content-length"]);
    // The service checks the abstract, token, status and window before it
    // calls readFinalFile, so a rejected caller's body is never buffered.
    return this.finalFile.uploadAbstractFinalFile(
      id,
      token,
      () => readFinalFile(req),
      req.ip,
    );
  }
}

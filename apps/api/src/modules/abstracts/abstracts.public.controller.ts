import { readSingleFile, type MultipartRequest } from "../../core/multipart";
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
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
} from "./abstracts.final-file.service";
import { extractAbstractToken } from "./abstracts.token";
import {
  EventSlugParamDto,
  AbstractIdParamDto,
  AbstractTokenQueryDto,
  SubmitAbstractDto,
  EditAbstractDto,
} from "./abstracts.dto";

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
    // calls the file reader, so a rejected caller's body is never buffered.
    return this.finalFile.uploadAbstractFinalFile(
      id,
      token,
      () => readSingleFile(req, {
        fileSize: MAX_FINAL_FILE_SIZE,
        fileReadErrorsAsMissing: true,
        onTooLarge: finalFileTooLarge,
      }),
      req.ip,
    );
  }
}

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
import { AbstractsService } from "./abstracts.service";
import { AbstractsFinalFileService } from "./abstracts.final-file.service";
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

// Env-driven public rate limits (legacy publicRateLimits.abstracts*). Read at
// module load — the app-config zod schema validates these at boot.
// ponytail: parseWindowMs handles a bare-ms number or "N unit"; extend the unit
// map if an exotic window string is ever configured.
function parseWindowMs(raw: string | undefined): number {
  if (!raw) return 60_000;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /^(\d+)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)$/i.exec(
    trimmed,
  );
  if (!match) return 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "ms") return n;
  if (unit.startsWith("h")) return n * 3_600_000;
  if (unit === "m" || unit.startsWith("min")) return n * 60_000;
  return n * 1_000;
}

const WINDOW_MS = parseWindowMs(process.env.ABSTRACTS_RATE_LIMIT_WINDOW);
const SUBMIT_THROTTLE = {
  default: {
    limit: Number(process.env.ABSTRACTS_SUBMIT_RATE_LIMIT_MAX) || 60,
    ttl: WINDOW_MS,
  },
};
const EDIT_THROTTLE = {
  default: {
    limit: Number(process.env.ABSTRACTS_EDIT_RATE_LIMIT_MAX) || 30,
    ttl: WINDOW_MS,
  },
};
const READ_THROTTLE = {
  default: {
    limit: Number(process.env.ABSTRACTS_READ_RATE_LIMIT_MAX) || 120,
    ttl: WINDOW_MS,
  },
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
    const data = await req
      .file({ limits: { fileSize: 50 * 1024 * 1024 } })
      .catch(() => null);
    if (!data) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: "No file uploaded",
      });
    }
    const buffer = await data.toBuffer();
    return this.finalFile.uploadAbstractFinalFile(
      id,
      token,
      { buffer, filename: data.filename, mimetype: data.mimetype },
      req.ip,
    );
  }
}

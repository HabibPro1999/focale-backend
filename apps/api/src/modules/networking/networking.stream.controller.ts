import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SkipEnvelope } from "../../core/envelope.interceptor";
import { NetworkingStreamService } from "./networking.stream";

/** The participant notification stream (SSE); see NetworkingStreamService. */
@Controller("api/networking/:slug")
export class NetworkingStreamController {
  constructor(private readonly streams: NetworkingStreamService) {}

  @Get("stream")
  @SkipEnvelope()
  stream(
    @Param("slug") slug: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.streams.open(slug, req, reply);
  }
}

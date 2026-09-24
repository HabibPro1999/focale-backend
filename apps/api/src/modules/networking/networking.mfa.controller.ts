import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Ip,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { NetworkingService } from "./networking.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import { NetworkingMfaCodeDto } from "./networking.dto";
@Controller("api/networking/:slug/auth/mfa")
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class NetworkingMfaController {
  constructor(
    private readonly networking: NetworkingService,
    private readonly mfa: NetworkingMfaService,
  ) {}
  private context(slug: string, ip: string, authorization?: string) {
    return this.networking.participant(slug, authorization, {
      allowPendingSecondFactor: true,
      allowConsentPending: true,
      ip,
    });
  }
  @Get() async state(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.state(await this.context(slug, ip, authorization));
  }
  @Post("enroll") async enroll(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.enroll(await this.context(slug, ip, authorization));
  }
  @Post("confirm") async confirm(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(
      await this.context(slug, ip, authorization),
      body.code,
      "CONFIRM",
    );
  }
  @Post("verify") async verify(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(await this.context(slug, ip, authorization), body.code);
  }
  @Delete() async disable(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(
      await this.networking.participant(slug, authorization, { allowConsentPending: true, ip }),
      body.code,
      "DISABLE",
    );
  }
}

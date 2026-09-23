import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
  private context(slug: string, authorization?: string) {
    return this.networking.participant(slug, authorization, {
      allowPendingSecondFactor: true,
      allowConsentPending: true,
    });
  }
  @Get() async state(
    @Param("slug") slug: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.state(await this.context(slug, authorization));
  }
  @Post("enroll") async enroll(
    @Param("slug") slug: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.enroll(await this.context(slug, authorization));
  }
  @Post("confirm") async confirm(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(
      await this.context(slug, authorization),
      body.code,
      "CONFIRM",
    );
  }
  @Post("verify") async verify(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(await this.context(slug, authorization), body.code);
  }
  @Delete() async disable(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(
      await this.networking.participant(slug, authorization, { allowConsentPending: true }),
      body.code,
      "DISABLE",
    );
  }
}

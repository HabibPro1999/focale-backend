import * as responses from "@app/contracts";
import { ResponseContract } from "../../core/response-contract";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Ip,
  Param,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { NetworkingBusyInterceptor } from "./networking.busy";
import { Throttle } from "@nestjs/throttler";
import { NetworkingService } from "./networking.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import { NetworkingMfaCodeDto } from "./networking.dto";
@UseInterceptors(NetworkingBusyInterceptor)
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
  @ResponseContract(responses.NetworkingMfaStateResponseSchema)
  @Get() async state(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.state(await this.context(slug, ip, authorization));
  }
  @ResponseContract(responses.NetworkingMfaEnrollResponseSchema)
  @Post("enroll") async enroll(
    @Param("slug") slug: string,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.enroll(await this.context(slug, ip, authorization));
  }
  @ResponseContract(responses.NetworkingMfaConfirmResponseSchema)
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
  @ResponseContract(responses.NetworkingMfaVerifyResponseSchema)
  @Post("verify") async verify(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(await this.context(slug, ip, authorization), body.code);
  }
  /** Replaces every recovery code after a valid authenticator or recovery code (REGENERATE_RECOVERY). */
  @ResponseContract(responses.NetworkingMfaRegenerateRecoveryCodesResponseSchema)
  @Post("recovery-codes") async regenerateRecoveryCodes(
    @Param("slug") slug: string,
    @Body() body: NetworkingMfaCodeDto,
    @Ip() ip: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.mfa.verify(
      await this.context(slug, ip, authorization),
      body.code,
      "REGENERATE_RECOVERY",
    );
  }
  @ResponseContract(responses.NetworkingMfaDisableResponseSchema)
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

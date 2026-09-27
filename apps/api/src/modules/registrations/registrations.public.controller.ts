import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { readSingleFile, type MultipartRequest } from "../../core/multipart";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";
import { RegistrationsCreateService } from "./registrations.create.service";
import { RegistrationSelfService } from "./registration-self.service";
import { RegistrationPaymentProofService } from "./registration-payment-proof.service";
import {
  CreateRegistrationBodyDto,
  EditTokenQueryDto,
  FormIdParamDto,
  PublicEditRegistrationDto,
  RegistrationIdPublicParamDto,
  SelectPaymentMethodDto,
} from "./registrations.dto";

// Legacy publicRateLimits presets.
const REGISTRATION_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
const EDIT_TOKEN_THROTTLE = { default: { limit: 3, ttl: 60_000 } };
const PAYMENT_PROOF_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

// POST /api/public/forms/:formId/register — submit a public registration.
@Controller("api/public/forms")
export class RegistrationsPublicController {
  constructor(private readonly create: RegistrationsCreateService) {}

  @Post(":formId/register")
  @Throttle(REGISTRATION_THROTTLE)
  async register(
    @Param() { formId }: FormIdParamDto,
    @Body() body: CreateRegistrationBodyDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { created, registration, priceBreakdown } =
      await this.create.createPublicRegistration(formId, body);
    // Idempotency hits return 200; a fresh create returns 201.
    void reply.status(created ? 201 : 200);
    return { registration, priceBreakdown };
  }
}

// Self-service edit — 64-hex edit token via X-Edit-Token header or ?token=.
@Controller("api/public/registrations")
export class RegistrationEditPublicController {
  constructor(
    private readonly self: RegistrationSelfService,
    private readonly proof: RegistrationPaymentProofService,
  ) {}

  /** Header preferred over query. 401 if absent/malformed; 403 if it does not match. */
  private async requireToken(
    registrationId: string,
    headerToken: string | undefined,
    queryToken: string | undefined,
  ): Promise<void> {
    const token = headerToken || queryToken;
    if (!token || token.length !== 64) {
      throw new AppException(
        ErrorCodes.INVALID_TOKEN,
        "Edit token required",
        401,
      );
    }
    if (!(await this.self.verifyEditToken(registrationId, token))) {
      throw new AppException(ErrorCodes.FORBIDDEN, "Invalid edit token", 403);
    }
  }

  @Get(":registrationId")
  @Throttle(EDIT_TOKEN_THROTTLE)
  async getForEdit(
    @Param() { registrationId }: RegistrationIdPublicParamDto,
    @Query() { token }: EditTokenQueryDto,
    @Headers("x-edit-token") headerToken?: string,
  ) {
    await this.requireToken(registrationId, headerToken, token);
    return this.self.getRegistrationForEdit(registrationId);
  }

  @Patch(":registrationId")
  @Throttle(EDIT_TOKEN_THROTTLE)
  async edit(
    @Param() { registrationId }: RegistrationIdPublicParamDto,
    @Query() { token }: EditTokenQueryDto,
    @Body() body: PublicEditRegistrationDto,
    @Headers("x-edit-token") headerToken?: string,
  ) {
    await this.requireToken(registrationId, headerToken, token);
    return this.self.editRegistrationPublic(registrationId, body);
  }

  // PATCH /api/public/registrations/:registrationId/payment-method → { success: true }
  @Patch(":registrationId/payment-method")
  @Throttle(EDIT_TOKEN_THROTTLE)
  async selectPaymentMethod(
    @Param() { registrationId }: RegistrationIdPublicParamDto,
    @Query() { token }: EditTokenQueryDto,
    @Body() body: SelectPaymentMethodDto,
    @Headers("x-edit-token") headerToken?: string,
  ) {
    await this.requireToken(registrationId, headerToken, token);
    await this.self.selectPaymentMethod(registrationId, body);
    return { success: true };
  }

  // POST /api/public/registrations/:registrationId/payment-proof — multipart upload
  @Post(":registrationId/payment-proof")
  @HttpCode(201)
  @Throttle(PAYMENT_PROOF_THROTTLE)
  async uploadPaymentProof(
    @Param() { registrationId }: RegistrationIdPublicParamDto,
    @Query() { token }: EditTokenQueryDto,
    @Req() req: MultipartRequest,
    @Headers("x-edit-token") headerToken?: string,
  ) {
    await this.requireToken(registrationId, headerToken, token);
    const file = await readSingleFile(req);
    return this.proof.uploadPaymentProof(registrationId, file);
  }
}

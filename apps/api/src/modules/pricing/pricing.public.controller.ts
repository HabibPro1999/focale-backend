import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ErrorCodes, type PriceBreakdown } from "@app/contracts";
import { sanitizeFormData, validateFormData } from "@app/shared";
import { AppException } from "../../core/app-exception";
import { assertEventAcceptsPublicActions } from "../events";
import { isModuleEnabledForClient } from "../clients/module-gates";
import { PricingService } from "./pricing.service";
import { CalculatePriceRequestDto, FormIdParamDto } from "./pricing.dto";

@Controller("api/public/forms")
export class PricingPublicController {
  constructor(private readonly pricing: PricingService) {}

  // POST /api/public/forms/:formId/calculate-price — public price quote, 10/min.
  @Post(":formId/calculate-price")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async calculatePrice(
    @Param() { formId }: FormIdParamDto,
    @Body() input: CalculatePriceRequestDto,
  ): Promise<PriceBreakdown> {
    const form = await this.pricing.getFormForPriceQuote(formId);
    if (!form || form.type !== "REGISTRATION" || !form.active) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }

    assertEventAcceptsPublicActions(form.event);

    if (!isModuleEnabledForClient(form.event.client, "pricing")) {
      // Distinct public-facing message (NOT the shared gate's "...for this client").
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Pricing module is disabled",
        403,
      );
    }

    const validationResult = validateFormData(form.schema, input.formData);
    if (!validationResult.valid) {
      throw new AppException(
        ErrorCodes.FORM_VALIDATION_ERROR,
        "Form validation failed",
        400,
        { fieldErrors: validationResult.errors },
      );
    }

    const sanitizedFormData = sanitizeFormData(form.schema, input.formData);
    return this.pricing.calculatePrice(form.eventId, {
      ...input,
      formData: sanitizedFormData,
    });
  }
}

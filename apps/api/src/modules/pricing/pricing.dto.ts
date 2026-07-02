import {
  CalculatePriceRequestSchema,
  CreateEmbeddedRuleSchema,
  PricingEventIdParamSchema,
  PricingFormIdParamSchema,
  PricingRuleIdParamSchema,
  UpdateEmbeddedRuleSchema,
  UpdateEventPricingSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class EventIdParamDto extends createZodDto(PricingEventIdParamSchema) {}
export class RuleIdParamDto extends createZodDto(PricingRuleIdParamSchema) {}
export class FormIdParamDto extends createZodDto(PricingFormIdParamSchema) {}
export class UpdateEventPricingDto extends createZodDto(
  UpdateEventPricingSchema,
) {}
export class CreateEmbeddedRuleDto extends createZodDto(
  CreateEmbeddedRuleSchema,
) {}
export class UpdateEmbeddedRuleDto extends createZodDto(
  UpdateEmbeddedRuleSchema,
) {}
export class CalculatePriceRequestDto extends createZodDto(
  CalculatePriceRequestSchema,
) {}

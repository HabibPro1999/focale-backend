import {
  CreateFormSchema,
  UpdateFormSchema,
  ListFormsQuerySchema,
  FormIdParamSchema,
  UpdateSponsorshipSettingsSchema,
  CreateSponsorFormBodySchema,
  EventIdParamSchema,
  EventSlugParamSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateFormDto extends createZodDto(CreateFormSchema) {}
export class UpdateFormDto extends createZodDto(UpdateFormSchema) {}
export class ListFormsQueryDto extends createZodDto(ListFormsQuerySchema) {}
export class FormIdParamDto extends createZodDto(FormIdParamSchema) {}
export class UpdateSponsorshipSettingsDto extends createZodDto(
  UpdateSponsorshipSettingsSchema,
) {}
export class CreateSponsorFormBodyDto extends createZodDto(
  CreateSponsorFormBodySchema,
) {}

export class EventIdParamDto extends createZodDto(EventIdParamSchema) {}
export class EventSlugParamDto extends createZodDto(EventSlugParamSchema) {}

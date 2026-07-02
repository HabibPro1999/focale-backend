import { z } from "zod";
import {
  CreateFormSchema,
  UpdateFormSchema,
  ListFormsQuerySchema,
  FormIdParamSchema,
  UpdateSponsorshipSettingsSchema,
  CreateSponsorFormBodySchema,
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

// Event/slug params. Mirror the events module contract shapes (EventIdParamSchema
// = { id: uuid }, EventSlugParamSchema = { slug: 1..100 }); kept local so the
// forms controllers don't depend on the events contract barrel.
export const EventIdParamSchema = z.strictObject({ id: z.string().uuid() });
export const EventSlugParamSchema = z.strictObject({
  slug: z.string().min(1).max(100),
});
export class EventIdParamDto extends createZodDto(EventIdParamSchema) {}
export class EventSlugParamDto extends createZodDto(EventSlugParamSchema) {}

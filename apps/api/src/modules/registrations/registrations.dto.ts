import { z } from "zod";
import {
  EventRegistrationIdParamSchema,
  RegistrationIdPublicParamSchema,
  EditTokenQuerySchema,
  ListRegistrationsQuerySchema,
  SearchRegistrantsQuerySchema,
  DeleteRegistrationQuerySchema,
  AdminCreateRegistrationSchema,
  AdminEditRegistrationSchema,
  UpdateRegistrationSchema,
  UpdatePaymentSchema,
  SelectPaymentMethodSchema,
  CreateRegistrationBodySchema,
  PublicEditRegistrationSchema,
  ListRegistrationAuditLogsQuerySchema,
  ListRegistrationEmailLogsQuerySchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

// Params — declared inline: the events/forms contracts' *IdParamSchema use `id`,
// but these registrations routes use `:eventId` / `:formId` path params.
export class EventIdParamDto extends createZodDto(
  z.strictObject({ eventId: z.string().uuid() }),
) {}
export class FormIdParamDto extends createZodDto(
  z.strictObject({ formId: z.string().uuid() }),
) {}
export class RegistrationIdParamDto extends createZodDto(
  z.strictObject({ id: z.string().uuid() }),
) {}
export class EventRegistrationIdParamDto extends createZodDto(
  EventRegistrationIdParamSchema,
) {}
export class RegistrationIdPublicParamDto extends createZodDto(
  RegistrationIdPublicParamSchema,
) {}

// Query
export class EditTokenQueryDto extends createZodDto(EditTokenQuerySchema) {}
export class ListRegistrationsQueryDto extends createZodDto(
  ListRegistrationsQuerySchema,
) {}
export class SearchRegistrantsQueryDto extends createZodDto(
  SearchRegistrantsQuerySchema,
) {}
export class DeleteRegistrationQueryDto extends createZodDto(
  DeleteRegistrationQuerySchema,
) {}
export class ListRegistrationAuditLogsQueryDto extends createZodDto(
  ListRegistrationAuditLogsQuerySchema,
) {}
export class ListRegistrationEmailLogsQueryDto extends createZodDto(
  ListRegistrationEmailLogsQuerySchema,
) {}

// Body
export class AdminCreateRegistrationDto extends createZodDto(
  AdminCreateRegistrationSchema,
) {}
export class AdminEditRegistrationDto extends createZodDto(
  AdminEditRegistrationSchema,
) {}
export class UpdateRegistrationDto extends createZodDto(UpdateRegistrationSchema) {}
export class UpdatePaymentDto extends createZodDto(UpdatePaymentSchema) {}
export class SelectPaymentMethodDto extends createZodDto(
  SelectPaymentMethodSchema,
) {}
export class CreateRegistrationBodyDto extends createZodDto(
  CreateRegistrationBodySchema,
) {}
export class PublicEditRegistrationDto extends createZodDto(
  PublicEditRegistrationSchema,
) {}

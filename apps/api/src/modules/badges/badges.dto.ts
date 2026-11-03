import {
  BadgeEventIdParamSchema,
  BadgeIdParamSchema,
  BadgeRegistrationIdParamSchema,
  CreateBadgeTemplateSchema,
  EmailVariablesQuerySchema,
  RegistrationBadgeQuerySchema,
  UpdateBadgeTemplateSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class BadgeEventIdParamDto extends createZodDto(BadgeEventIdParamSchema) {}
export class BadgeIdParamDto extends createZodDto(BadgeIdParamSchema) {}
export class BadgeRegistrationIdParamDto extends createZodDto(BadgeRegistrationIdParamSchema) {}
export class RegistrationBadgeQueryDto extends createZodDto(RegistrationBadgeQuerySchema) {}
export class CreateBadgeTemplateDto extends createZodDto(CreateBadgeTemplateSchema) {}
export class UpdateBadgeTemplateDto extends createZodDto(UpdateBadgeTemplateSchema) {}
/** The email variables query (`?language=`): the badge palette is the email variable catalogue. */
export class BadgeVariablesQueryDto extends createZodDto(EmailVariablesQuerySchema) {}

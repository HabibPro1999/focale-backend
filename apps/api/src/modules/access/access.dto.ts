import {
  CreateEventAccessBodySchema,
  UpdateEventAccessSchema,
  ListEventAccessQuerySchema,
  EventAccessIdParamSchema,
  AccessEventIdParamSchema,
  PublicAccessItemParamSchema,
  GetGroupedAccessBodySchema,
  ValidateAccessSelectionsBodySchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateEventAccessBodyDto extends createZodDto(
  CreateEventAccessBodySchema,
) {}
export class UpdateEventAccessDto extends createZodDto(UpdateEventAccessSchema) {}
export class ListEventAccessQueryDto extends createZodDto(
  ListEventAccessQuerySchema,
) {}
export class EventAccessIdParamDto extends createZodDto(EventAccessIdParamSchema) {}
export class AccessEventIdParamDto extends createZodDto(AccessEventIdParamSchema) {}
export class PublicAccessItemParamDto extends createZodDto(
  PublicAccessItemParamSchema,
) {}
export class GetGroupedAccessBodyDto extends createZodDto(
  GetGroupedAccessBodySchema,
) {}
export class ValidateAccessSelectionsBodyDto extends createZodDto(
  ValidateAccessSelectionsBodySchema,
) {}

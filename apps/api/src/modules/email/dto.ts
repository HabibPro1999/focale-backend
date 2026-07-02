import {
  CreateEmailTemplateBodySchema,
  UpdateEmailTemplateSchema,
  ListEmailTemplatesQuerySchema,
  ListEventEmailLogsQuerySchema,
  TestSendEmailSchema,
  BulkSendEmailSchema,
  SendCustomEmailSchema,
  EmailEventIdParamSchema,
  EmailTemplateIdParamSchema,
  BulkSendParamSchema,
  SendCustomEmailParamSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateEmailTemplateBodyDto extends createZodDto(
  CreateEmailTemplateBodySchema,
) {}
export class UpdateEmailTemplateDto extends createZodDto(
  UpdateEmailTemplateSchema,
) {}
export class ListEmailTemplatesQueryDto extends createZodDto(
  ListEmailTemplatesQuerySchema,
) {}
export class ListEventEmailLogsQueryDto extends createZodDto(
  ListEventEmailLogsQuerySchema,
) {}
export class TestSendEmailDto extends createZodDto(TestSendEmailSchema) {}
export class BulkSendEmailDto extends createZodDto(BulkSendEmailSchema) {}
export class SendCustomEmailDto extends createZodDto(SendCustomEmailSchema) {}

export class EmailEventIdParamDto extends createZodDto(
  EmailEventIdParamSchema,
) {}
export class EmailTemplateIdParamDto extends createZodDto(
  EmailTemplateIdParamSchema,
) {}
export class BulkSendParamDto extends createZodDto(BulkSendParamSchema) {}
export class SendCustomEmailParamDto extends createZodDto(
  SendCustomEmailParamSchema,
) {}

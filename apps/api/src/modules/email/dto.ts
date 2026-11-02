import {
  CreateEmailTemplateBodySchema,
  DraftEmailPreviewSchema,
  DraftEmailTestSendSchema,
  DuplicateEmailTemplateSchema,
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
  ResendEmailLogParamSchema,
  GetEmailLogParamSchema,
  EmailVariablesQuerySchema,
} from "@app/contracts";
import { z } from "zod";
import { createZodDto } from "../../core/zod";

export class CreateEmailTemplateBodyDto extends createZodDto(
  CreateEmailTemplateBodySchema,
) {}
/** A missing body (the admin app sends none) reads as `{}`. */
export class DuplicateEmailTemplateDto extends createZodDto(
  z.preprocess((body) => body ?? {}, DuplicateEmailTemplateSchema),
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
export class ResendEmailLogParamDto extends createZodDto(
  ResendEmailLogParamSchema,
) {}

export class GetEmailLogParamDto extends createZodDto(GetEmailLogParamSchema) {}

export class DraftEmailPreviewDto extends createZodDto(DraftEmailPreviewSchema) {}
export class DraftEmailTestSendDto extends createZodDto(DraftEmailTestSendSchema) {}

export class EmailVariablesQueryDto extends createZodDto(EmailVariablesQuerySchema) {}

import {
  CertificateEventIdParamSchema,
  CertificateIdParamSchema,
  CreateCertificateTemplateSchema,
  UpdateCertificateTemplateSchema,
  SendCertificatesBodySchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CertificateEventIdParamDto extends createZodDto(
  CertificateEventIdParamSchema,
) {}
export class CertificateIdParamDto extends createZodDto(
  CertificateIdParamSchema,
) {}
export class CreateCertificateTemplateDto extends createZodDto(
  CreateCertificateTemplateSchema,
) {}
export class UpdateCertificateTemplateDto extends createZodDto(
  UpdateCertificateTemplateSchema,
) {}
export class SendCertificatesBodyDto extends createZodDto(
  SendCertificatesBodySchema,
) {}

import {
  ReportQuerySchema,
  ExportRegistrationsQuerySchema,
  ExportRegistrationsBodySchema,
  ExportSponsorshipsQuerySchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

// Route params (eventId/accessId) are intentionally NOT validated — legacy had
// no schema on them (a non-UUID id simply finds nothing -> 404, never 400).
export class ReportQueryDto extends createZodDto(ReportQuerySchema) {}
export class ExportRegistrationsQueryDto extends createZodDto(
  ExportRegistrationsQuerySchema,
) {}
export class ExportRegistrationsBodyDto extends createZodDto(
  ExportRegistrationsBodySchema,
) {}
export class ExportSponsorshipsQueryDto extends createZodDto(
  ExportSponsorshipsQuerySchema,
) {}

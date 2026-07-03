import {
  BatchSyncBodySchema,
  CheckInBodySchema,
  CheckInEventParamSchema,
  CheckInRegistrationsQuerySchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CheckInEventParamDto extends createZodDto(CheckInEventParamSchema) {}
export class CheckInBodyDto extends createZodDto(CheckInBodySchema) {}
export class BatchSyncBodyDto extends createZodDto(BatchSyncBodySchema) {}
export class CheckInRegistrationsQueryDto extends createZodDto(
  CheckInRegistrationsQuerySchema,
) {}

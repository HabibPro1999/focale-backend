import { StreamQuerySchema } from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class StreamQueryDto extends createZodDto(StreamQuerySchema) {}

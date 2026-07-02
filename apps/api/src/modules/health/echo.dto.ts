import { z } from "zod";
import { createZodDto } from "../../core/zod";

export class EchoDto extends createZodDto(z.object({ msg: z.string().min(1) })) {}

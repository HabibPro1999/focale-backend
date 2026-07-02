import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import type { ZodType, infer as ZodInfer } from "zod";

/** DTO class carrying a static zod schema the pipe can discover; instances are the schema output. */
export type ZodDtoStatic<T extends ZodType = ZodType> = (new () => ZodInfer<T>) & {
  schema: T;
};

/** `class EchoDto extends createZodDto(schema) {}` — instances typed as the schema output. */
export function createZodDto<T extends ZodType>(schema: T): ZodDtoStatic<T> {
  class ZodDto {
    static schema = schema;
  }
  return ZodDto as unknown as ZodDtoStatic<T>;
}

/** Thrown by the pipe on validation failure; rendered by the exception filter. */
export class ZodValidationException extends Error {
  constructor(public readonly details: unknown) {
    super("Validation failed");
    this.name = "ZodValidationException";
  }
}

function hasZodSchema(metatype: unknown): metatype is ZodDtoStatic {
  return (
    typeof metatype === "function" &&
    "schema" in metatype &&
    typeof (metatype as { schema?: unknown }).schema === "object" &&
    (metatype as { schema?: { safeParse?: unknown } }).schema?.safeParse !==
      undefined
  );
}

/** Global APP_PIPE. Validates any body/query/param arg whose DTO carries a static zod schema. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const metatype = metadata.metatype;
    if (!hasZodSchema(metatype)) return value;

    const result = metatype.schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationException(result.error.flatten());
    }
    return result.data;
  }
}

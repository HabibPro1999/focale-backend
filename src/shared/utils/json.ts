import type { Prisma } from "@/generated/prisma/client.js";

/**
 * Cast a typed value to `Prisma.InputJsonValue` for writing to a JSON column.
 *
 * Prisma's recursive `InputJsonValue` type does not structurally match plain
 * TypeScript objects (it omits `undefined`, requires nominal recursion). This
 * helper centralizes the necessary widening at JSON-column write sites instead
 * of scattering `as unknown as Prisma.InputJsonValue` across services.
 */
export function toInputJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Read a typed view of a JSON-column value. Caller asserts the shape.
 *
 * Use this instead of `value as unknown as T` so that JSON-read coercions
 * are greppable in one place. The cast is unsafe by definition; if you need
 * runtime validation, parse with Zod at the call site instead of using this.
 */
export function fromInputJson<T>(value: unknown): T {
  return value as T;
}

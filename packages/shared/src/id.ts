import { v7 as uuidv7 } from "uuid";

/** THE id generator everywhere: UUIDv7 (time-ordered). */
export function newId(): string {
  return uuidv7();
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** Process-unique worker identifier: `<prefix>:<host>:<pid>:<uuid>`. */
export function makeWorkerId(prefix: string): string {
  return `${prefix}:${hostname()}:${process.pid}:${randomUUID()}`;
}

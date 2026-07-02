import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = { requestId: string };

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Run `fn` within a fresh request context. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

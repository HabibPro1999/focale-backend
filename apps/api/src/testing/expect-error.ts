import { HttpException } from "@nestjs/common";
import { expect } from "vitest";
import { AppException } from "../core/app-exception";

/** Shared wire-error assertions; keep AppException checks where callers require them. */
function assertHttpError(error: unknown, status: number, code: string, message?: string): void {
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  const body = exception.getResponse() as { code: string; message: string };
  expect(body.code).toBe(code);
  if (message !== undefined) expect(body.message).toBe(message);
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => expect.fail("expected the call to throw"), (error: unknown) => error);
}

export async function expectHttpError(promise: Promise<unknown>, status: number, code: string, message?: string): Promise<void> {
  assertHttpError(await rejected(promise), status, code, message);
}

export async function expectAppError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(AppException);
  assertHttpError(error, status, code);
}

export function expectHttpErrorSync(fn: () => unknown, status: number, code: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assertHttpError(error, status, code);
}

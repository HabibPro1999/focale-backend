import { HttpException } from "@nestjs/common";
import { expect } from "vitest";
import { AppException } from "../core/app-exception";

async function expectException(
  promise: Promise<unknown>,
  status: number,
  code: string,
  exceptionClass: { prototype: HttpException },
  message?: string,
): Promise<void> {
  const error: unknown = await promise.then(
    () => { throw new Error("expected promise to reject"); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(exceptionClass);
  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(status);
  const body = exception.getResponse() as { code: string; message: string };
  expect(body.code).toBe(code);
  if (message !== undefined) expect(body.message).toBe(message);
}

export function expectHttpError(promise: Promise<unknown>, status: number, code: string, message?: string) {
  return expectException(promise, status, code, HttpException, message);
}

export function expectAppError(promise: Promise<unknown>, status: number, code: string, message?: string) {
  return expectException(promise, status, code, AppException, message);
}

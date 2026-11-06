import { expect, type Mock } from "vitest";
import { AppException } from "../../../core/app-exception";

export const mock = <T>(fn: T) => fn as unknown as Mock;

export async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(status);
}

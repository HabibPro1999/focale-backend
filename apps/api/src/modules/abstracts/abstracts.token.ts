import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ErrorCodes } from "@app/contracts";
import { AppException } from "./app-exception";

const TOKEN_LENGTH = 32; // 64 hex characters

/** Generate a secure random abstract edit token (64 hex chars). */
export function generateAbstractToken(): string {
  return randomBytes(TOKEN_LENGTH).toString("hex");
}

/** Timing-safe comparison of stored vs provided token. */
export function verifyAbstractToken(
  storedToken: string,
  providedToken: string,
): boolean {
  try {
    return timingSafeEqual(
      Buffer.from(storedToken, "utf8"),
      Buffer.from(providedToken, "utf8"),
    );
  } catch {
    // Buffer length mismatch or other error
    return false;
  }
}

/**
 * Extract the abstract token from the `X-Abstract-Token` header or `?token=`
 * query param (header wins). A missing/malformed (not exactly 64 chars) token
 * throws 401 BEFORE the service runs — a well-formed-but-wrong token surfaces as
 * 404 from the service (existence not leaked).
 */
export function extractAbstractToken(request: FastifyRequest): string {
  const headerToken = request.headers["x-abstract-token"] as string | undefined;
  const queryToken = (request.query as { token?: string }).token;
  const token = headerToken || queryToken;
  if (!token || token.length !== 64) {
    throw new AppException(
      ErrorCodes.INVALID_TOKEN,
      "Abstract token required",
      401,
    );
  }
  return token;
}

import { randomBytes, timingSafeEqual } from "crypto";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { FastifyRequest } from "fastify";

const TOKEN_LENGTH = 32; // 64 hex characters

/**
 * Generate a secure random abstract edit token.
 */
export function generateAbstractToken(): string {
  return randomBytes(TOKEN_LENGTH).toString("hex");
}

/**
 * Timing-safe comparison of stored vs provided token.
 */
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
 * Extract abstract token from X-Abstract-Token header or ?token= query string.
 * Header takes precedence.
 */
export function extractAbstractToken(request: FastifyRequest): string {
  const headerToken = request.headers["x-abstract-token"] as string | undefined;
  const queryToken = (request.query as { token?: string }).token;
  const token = headerToken || queryToken;
  if (!token || token.length !== 64) {
    throw new AppError("Abstract token required", 401, ErrorCodes.INVALID_TOKEN);
  }
  return token;
}

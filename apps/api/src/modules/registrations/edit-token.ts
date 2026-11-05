import { timingSafeEqual } from "node:crypto";
import { ErrorCodes } from "@app/contracts";
import { getRegistrationEditToken } from "@app/db";
import { AppException } from "../../core/app-exception";

/** Whether `token` is the registration's edit token (constant-time compare). */
export async function verifyRegistrationEditToken(
  registrationId: string,
  token: string,
): Promise<boolean> {
  const row = await getRegistrationEditToken(registrationId);
  if (!row?.editToken) return false;
  try {
    return timingSafeEqual(Buffer.from(row.editToken, "utf8"), Buffer.from(token, "utf8"));
  } catch {
    return false;
  }
}

/**
 * The self-service edit token of a public registration route, from the
 * X-Edit-Token header (preferred) or ?token=. 401 if absent or malformed;
 * 403 if it does not match.
 */
export async function requireRegistrationEditToken(
  registrationId: string,
  headerToken: string | undefined,
  queryToken: string | undefined,
): Promise<void> {
  const token = headerToken || queryToken;
  if (!token || token.length !== 64) {
    throw new AppException(ErrorCodes.INVALID_TOKEN, "Edit token required", 401);
  }
  if (!(await verifyRegistrationEditToken(registrationId, token))) {
    throw new AppException(ErrorCodes.FORBIDDEN, "Invalid edit token", 403);
  }
}

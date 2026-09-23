import { ErrorCodes } from "@app/contracts";
import { AppException } from "./app-exception";

/** Reject public link bases unless their HTTP(S) origin is explicitly trusted. */
export function assertPublicLinkBaseUrlAllowed(
  linkBaseUrl: string,
  allowedOrigins: readonly string[],
): void {
  let origin = "";
  try {
    const url = new URL(linkBaseUrl);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    ) {
      origin = url.origin;
    }
  } catch {
    // Treat malformed and unsupported URLs as untrusted.
  }

  if (!allowedOrigins.includes(origin)) {
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "linkBaseUrl origin is not allowed",
      422,
      { allowedOrigins },
    );
  }
}

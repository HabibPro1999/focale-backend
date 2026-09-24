import { isIP } from "node:net";

/**
 * TRUST_PROXY: explicit reverse-proxy peers whose forwarded headers Fastify
 * may trust. Numeric hop counts are rejected because they cannot validate the
 * address that connected to the API. Production must configure the real proxy
 * IP/CIDR list, or explicitly set TRUST_PROXY=false for direct traffic.
 *
 * Messages never echo the configured value.
 */
export const TRUST_PROXY_REQUIRED_MESSAGE =
  'TRUST_PROXY is required in production. Set it to a comma-separated list of trusted proxy IP/CIDR addresses, or "false" only when requests reach the API directly. Replace legacy hop counts with the actual proxy peer addresses; do not use "true" or wildcard trust.';

const UNSAFE_MESSAGE =
  'TRUST_PROXY value is unsafe or no longer supported. Set a comma-separated list of trusted proxy IP/CIDR addresses, or "false" only for direct traffic. Numeric hop counts cannot validate the connecting peer; wildcard trust is not allowed.';

const INVALID_LIST_MESSAGE =
  "TRUST_PROXY must contain only explicit IP addresses or CIDRs separated by commas; wildcard trust, hostnames, empty entries, and /0 networks are not allowed. Configure the actual proxy peer addresses; do not use a hop count.";

/** Why a (non-blank) TRUST_PROXY value is rejected, or null when it is valid. */
export function trustProxyValueError(raw: string): string | null {
  const value = raw.trim();
  if (value.toLowerCase() === "false") return null;
  if (value.toLowerCase() === "true" || value === "*" || Number.isFinite(Number(value))) {
    return UNSAFE_MESSAGE;
  }
  const addresses = value.split(",").map((address) => address.trim());
  if (addresses.some((address) => !address || !isExplicitProxyAddress(address))) {
    return INVALID_LIST_MESSAGE;
  }
  return null;
}

/**
 * Resolve a validated TRUST_PROXY value for Fastify: the de-duplicated address
 * list, or false (use the socket address). Unset means false; production
 * rejects unset at config validation.
 */
export function resolveTrustProxy(raw: string | undefined): string[] | false {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "false") return false;
  const error = trustProxyValueError(value);
  if (error) throw new Error(error);
  return [...new Set(value.split(",").map((address) => address.trim()))];
}

function isExplicitProxyAddress(value: string): boolean {
  const parts = value.split("/");
  if (parts.length > 2) return false;

  const [address, prefix] = parts;
  const family = isIP(address ?? "");
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;

  const bits = Number(prefix);
  const maxBits = family === 4 ? 32 : 128;
  // A zero-prefix CIDR trusts every possible peer and is equivalent to '*'.
  return Number.isInteger(bits) && bits > 0 && bits <= maxBits;
}

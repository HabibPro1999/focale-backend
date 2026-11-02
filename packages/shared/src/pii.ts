/**
 * Mask an email for anonymous surfaces: first character of the local part +
 * `***@` + domain (`alice@example.com` → `a***@example.com`). Splits on the
 * last `@`; input without a usable `@` never echoes the local part.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "***";
  const domain = email.slice(at + 1);
  const first = Array.from(email.slice(0, at))[0] ?? "";
  return `${first}***@${domain}`;
}

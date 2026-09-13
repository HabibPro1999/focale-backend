import { createHash } from "node:crypto";
import type { SendEmailInput } from "./email-provider.types";

type ProviderName = "resend" | "sendgrid";
export interface NetworkingEmailSender { provider: ProviderName; email: string; domainId: string; name?: string; }
const verified = new Map<string, number>();
const lifetime = 5 * 60_000;
/** Server-owned, client-keyed allowlist. This configuration is never accepted from participant requests. */
export function getNetworkingEmailSender(clientId: string, provider: ProviderName): NetworkingEmailSender | null {
  if (!process.env.NETWORKING_EMAIL_SENDERS) return null;
  let map: unknown;
  try { map = JSON.parse(process.env.NETWORKING_EMAIL_SENDERS); } catch { throw new Error("Networking sender configuration is invalid"); }
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Networking sender configuration is invalid");
  if (!Object.prototype.hasOwnProperty.call(map, clientId)) return null;
  const entry = (map as Record<string, unknown>)[clientId] as Partial<NetworkingEmailSender> | null;
  if (!entry || entry.provider !== provider || typeof entry.email !== "string" || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(entry.email) || entry.email.length > 254 || typeof entry.domainId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.domainId) || (provider === "sendgrid" && !/^\d+$/.test(entry.domainId)) || (entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length > 200 || /[\r\n]/.test(entry.name)))) throw new Error("Networking sender configuration is invalid for this client/provider");
  return { provider, email: entry.email, domainId: entry.domainId, ...(entry.name ? { name: entry.name } : {}) };
}
export function resetNetworkingSenderVerificationCache() { verified.clear(); }
/** Validate tenant ownership and actual provider domain status before an adapter can override From. */
export async function resolveVerifiedNetworkingSender(input: Pick<SendEmailInput, "fromEmail" | "senderClientId">, provider: ProviderName, apiKey?: string): Promise<string | undefined> {
  if (!input.fromEmail) return undefined;
  if (!input.senderClientId) throw new Error("A client-owned sender identity is required");
  const sender = getNetworkingEmailSender(input.senderClientId, provider);
  if (!sender || sender.email.toLowerCase() !== input.fromEmail.toLowerCase()) throw new Error("Sender identity is not approved for this client");
  const readKey = (provider === "resend" ? process.env.RESEND_DOMAIN_READ_API_KEY : process.env.SENDGRID_DOMAIN_READ_API_KEY) ?? apiKey;
  if (!readKey) throw new Error("Sender domain verification credentials are not configured");
  const cacheKey = `${provider}:${sender.domainId}:${sender.email.toLowerCase()}:${createHash("sha256").update(readKey).digest("hex")}`;
  if ((verified.get(cacheKey) ?? 0) > Date.now()) return sender.email;
  const endpoint = provider === "resend" ? `https://api.resend.com/domains/${encodeURIComponent(sender.domainId)}` : `https://api.sendgrid.com/v3/whitelabel/domains/${encodeURIComponent(sender.domainId)}`;
  let response: Response;
  try { response = await fetch(endpoint, { headers: { Authorization: `Bearer ${readKey}`, Accept: "application/json", "User-Agent": "Focale-Networking/1.0" }, signal: AbortSignal.timeout(10000), redirect: "error" }); }
  catch { throw new Error("Sender domain verification is temporarily unavailable"); }
  if (!response.ok) throw new Error("Sender domain verification was denied by the provider");
  const data = await response.json() as { id?: string | number; name?: string; domain?: string; status?: string; valid?: boolean; capabilities?: { sending?: string } };
  const domain = sender.email.slice(sender.email.lastIndexOf("@") + 1).toLowerCase();
  const matches = String(data.id) === sender.domainId && (provider === "resend" ? data.name?.toLowerCase() === domain && data.status === "verified" && data.capabilities?.sending === "enabled" : data.domain?.toLowerCase() === domain && data.valid === true);
  if (!matches) throw new Error("Sender identity domain is not verified for sending");
  verified.set(cacheKey, Date.now() + lifetime);
  return sender.email;
}
export async function networkingEmailSenderStatus(clientId: string) {
  const provider: ProviderName = process.env.EMAIL_PROVIDER === "resend" ? "resend" : "sendgrid";
  const sender = getNetworkingEmailSender(clientId, provider);
  if (!sender) return { configured: false as const, provider };
  try { await resolveVerifiedNetworkingSender({ fromEmail: sender.email, senderClientId: clientId }, provider, provider === "resend" ? process.env.RESEND_API_KEY : process.env.SENDGRID_API_KEY); return { configured: true as const, verified: true, provider, email: sender.email, name: sender.name }; }
  catch (error) { return { configured: true as const, verified: false, provider, email: sender.email, name: sender.name, error: error instanceof Error ? error.message : "Sender verification failed" }; }
}

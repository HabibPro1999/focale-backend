import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sendgrid: vi.fn(async (_input: unknown) => [{ headers: { "x-message-id": "test-sg" } }, {}]), resend: vi.fn(async (_input: unknown) => ({ data: { id: "test-re" }, error: null })) }));
vi.mock("@sendgrid/mail", () => ({ default: { setApiKey: vi.fn(), send: mocks.sendgrid } }));
vi.mock("resend", () => ({ Resend: class { emails = { send: mocks.resend }; webhooks = { verify: vi.fn() }; } }));
import { SendgridProvider } from "./sendgrid.provider";
import { ResendProvider } from "./resend.provider";
import { getNetworkingEmailSender, resolveVerifiedNetworkingSender, resetNetworkingSenderVerificationCache, networkingEmailSenderStatus } from "./networking-sender";
const resendMap = { "client-a": { provider: "resend", email: "networking@client-a.example", domainId: "domain-a", name: "Client A" } };
const sendgridMap = { "client-a": { provider: "sendgrid", email: "networking@client-a.example", domainId: "123" } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { resetNetworkingSenderVerificationCache(); mocks.sendgrid.mockClear(); mocks.resend.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("server-owned verified networking sender identities", () => {
  it("preserves global sender behavior without any domain verification call", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await resolveVerifiedNetworkingSender({}, "resend", "test-key")).toBeUndefined();
    await new ResendProvider({ apiKey: "re_test", fromEmail: "global@example.invalid", fromName: "Global" }).sendEmail({ to: "recipient@example.invalid", subject: "Test", html: "<p>Test</p>" });
    expect(mocks.resend.mock.calls[0][0]).toMatchObject({ from: "Global <global@example.invalid>" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects another client's sender and unapproved From values before contacting any provider", async () => {
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(resendMap)); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(resolveVerifiedNetworkingSender({ senderClientId: "client-b", fromEmail: resendMap["client-a"].email }, "resend", "test-key")).rejects.toThrow("not approved");
    await expect(resolveVerifiedNetworkingSender({ senderClientId: "client-a", fromEmail: "forged@evil.example" }, "resend", "test-key")).rejects.toThrow("not approved"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks the exact Resend domain and actual verified sending state before overriding the adapter", async () => {
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(resendMap)); vi.stubEnv("RESEND_DOMAIN_READ_API_KEY", "test-only-domain-read-key");
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ id: "domain-a", name: "client-a.example", status: "verified", capabilities: { sending: "enabled" } })); vi.stubGlobal("fetch", fetcher);
    const result = await new ResendProvider({ apiKey: "re_test_sending", fromEmail: "global@example.invalid", fromName: "Global" }).sendEmail({ to: "recipient@example.invalid", subject: "Test", html: "<p>Test</p>", fromEmail: resendMap["client-a"].email, senderClientId: "client-a", fromName: "Client A" });
    expect(result.success).toBe(true); expect(mocks.resend.mock.calls[0][0]).toMatchObject({ from: "Client A <networking@client-a.example>" });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.resend.com/domains/domain-a");
    expect((fetcher.mock.calls as unknown[][])[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test-only-domain-read-key" } });
  });
  it("rejects pending, disabled, unknown-capability or mismatched provider domains without sending", async () => {
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(resendMap));
    for (const data of [{ id: "domain-a", name: "client-a.example", status: "verified" }, { id: "domain-a", name: "client-a.example", status: "pending" }, { id: "domain-a", name: "client-a.example", status: "verified", capabilities: { sending: "disabled" } }, { id: "domain-a", name: "other-client.example", status: "verified" }]) {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => response(data)));
      const result = await new ResendProvider({ apiKey: "re_test", fromEmail: "global@example.invalid", fromName: "Global" }).sendEmail({ to: "recipient@example.invalid", subject: "Test", html: "<p>Test</p>", fromEmail: resendMap["client-a"].email, senderClientId: "client-a" });
      expect(result.success).toBe(false);
    }
    expect(mocks.resend).not.toHaveBeenCalled();
  });
  it("checks SendGrid domain authentication before applying a tenant sender", async () => {
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(sendgridMap));
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ id: 123, domain: "client-a.example", valid: true })); vi.stubGlobal("fetch", fetcher);
    const result = await new SendgridProvider({ apiKey: "SG.test", fromEmail: "global@example.invalid", fromName: "Global" }).sendEmail({ to: "recipient@example.invalid", subject: "Test", html: "<p>Test</p>", fromEmail: sendgridMap["client-a"].email, senderClientId: "client-a" });
    expect(result.success).toBe(true); expect(fetcher.mock.calls[0][0]).toBe("https://api.sendgrid.com/v3/whitelabel/domains/123"); expect(mocks.sendgrid.mock.calls[0][0]).toMatchObject({ from: { email: "networking@client-a.example" } });
  });
  it("fails closed on verification permission errors and removes authority immediately when allowlist changes", async () => {
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(resendMap)); vi.stubEnv("EMAIL_PROVIDER", "resend"); vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => response({ error: "test only" }, 403)));
    expect(await networkingEmailSenderStatus("client-a")).toMatchObject({ configured: true, verified: false });
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ id: "domain-a", name: "client-a.example", status: "verified", capabilities: { sending: "enabled" } })); vi.stubGlobal("fetch", fetcher);
    await resolveVerifiedNetworkingSender({ senderClientId: "client-a", fromEmail: resendMap["client-a"].email }, "resend", "re_test");
    await resolveVerifiedNetworkingSender({ senderClientId: "client-a", fromEmail: resendMap["client-a"].email }, "resend", "re_test"); expect(fetcher).toHaveBeenCalledOnce();
    vi.stubEnv("NETWORKING_EMAIL_SENDERS", "{}"); await expect(resolveVerifiedNetworkingSender({ senderClientId: "client-a", fromEmail: resendMap["client-a"].email }, "resend", "re_test")).rejects.toThrow("not approved");
  });
  it("rejects malformed server configuration and path/header injection", () => {
    for (const map of [{ "client-a": { ...resendMap["client-a"], domainId: "../../other" } }, { "client-a": { ...resendMap["client-a"], email: "x@a.example\r\nBcc: forged@example.invalid" } }, { "client-a": { ...resendMap["client-a"], name: "Forged\r\nFrom" } }]) { vi.stubEnv("NETWORKING_EMAIL_SENDERS", JSON.stringify(map)); expect(() => getNetworkingEmailSender("client-a", "resend")).toThrow(); }
  });
});

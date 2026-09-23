import { createCipheriv,createHash,randomBytes } from "node:crypto";
import { describe,expect,it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import { decryptNetworkingCode,escapeNetworkingHtml,renderNetworkingNotification,type NetworkingNotificationContext } from "./notification-rendering";
import { allowedNetworkingPushEndpoint } from "./notification-worker";

describe("networking notification boundaries",()=>{
 it("decrypts authenticated OTP payloads and rejects tampering",()=>{
  const secret="test-networking-secret-at-least-32-characters";
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",createHash("sha256").update(secret).digest(),iv);
  const encrypted=Buffer.concat([cipher.update("123456"),cipher.final()]);
  const payload=[iv,cipher.getAuthTag(),encrypted].map(value=>value.toString("base64url")).join(".");
  expect(decryptNetworkingCode(payload,secret)).toBe("123456");
  expect(()=>decryptNetworkingCode(payload,"another-secret-at-least-32-characters")).toThrow();
  encrypted[0]=encrypted[0]!^1;
  const tampered=[iv,cipher.getAuthTag(),encrypted].map(value=>value.toString("base64url")).join(".");
  expect(()=>decryptNetworkingCode(tampered,secret)).toThrow();
 });
 it("escapes user-authored names, company names and template bodies",()=>{
  expect(escapeNetworkingHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
 });
 it("limits outbound push requests to browser push providers",()=>{
  expect(allowedNetworkingPushEndpoint("https://fcm.googleapis.com/fcm/send/test")).toBe(true);
  expect(allowedNetworkingPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/test")).toBe(true);
  expect(allowedNetworkingPushEndpoint("https://web.push.apple.com/test")).toBe(true);
  for(const url of ["http://localhost/","https://127.0.0.1/admin","https://metadata.google.internal/","https://fcm.googleapis.com.evil.example/","https://evil.example/fcm.googleapis.com","https://user:pass@fcm.googleapis.com/test"])expect(allowedNetworkingPushEndpoint(url)).toBe(false);
 });
});

describe("declined counter-proposals", () => {
  it.each(["CONFIRMED", "PENDING_ALLOCATION"] as const)("renders a declined new time on a %s meeting as 'new time declined', not a declined meeting", (status) => {
    const startsAt = new Date("2099-04-20T08:00:00.000Z");
    const ctx = {
      event: { slug: "demo", name: "Demo" }, profile: { id: "a", language: "en", firstName: "Ann" },
      config: NetworkingConfigSchema.parse({ timezone: "UTC", defaultLanguage: "en" }),
      meeting: { id: "m", status, startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), requesterId: "a", recipientId: "b", proposedStartsAt: null, proposalBy: null, message: "", cancellationNote: "", updatedAt: startsAt, revision: 2 },
      table: null, contact: null, blocked: false, subscriptions: [],
    } as unknown as NetworkingNotificationContext;
    const rendered = renderNetworkingNotification("MEETING_DECLINE", {}, ctx);
    expect(rendered.title).toBe("The proposed new time was declined; the original meeting is maintained");
    expect(rendered.relativeHref).toBe("/e/demo/agenda");
  });
});

import { createCipheriv,createHash,randomBytes } from "node:crypto";
import { describe,expect,it } from "vitest";
import { decryptNetworkingCode,escapeNetworkingHtml } from "./notification-rendering";
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

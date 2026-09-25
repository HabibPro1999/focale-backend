import { createCipheriv,createHash,randomBytes } from "node:crypto";
import { describe,expect,it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import { NetworkingKeyring } from "@app/shared";
import { resetIntegrationsConfig } from "../config";
import { openNetworkingCode,renderNetworkingNotification,type NetworkingNotificationContext } from "./notification-rendering";
import { allowedNetworkingPushEndpoint } from "./notification-worker";

describe("networking notification boundaries",()=>{
 it("opens legacy and v1 sealed OTP payloads with the keyring and rejects tampering or a missing key",()=>{
  const secret="test-networking-secret-at-least-32-characters";
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",createHash("sha256").update(secret).digest(),iv);
  const encrypted=Buffer.concat([cipher.update("123456"),cipher.final()]);
  const payload=[iv,cipher.getAuthTag(),encrypted].map(value=>value.toString("base64url")).join(".");
  const k1="k1-networking-key-at-least-32-characters-long";
  const env={NETWORKING_TOKEN_SECRET:secret,NETWORKING_KEYS:undefined as string|undefined,NETWORKING_KEYRING_WRITE_V1:undefined as string|undefined};
  const run=<T>(overrides:Partial<typeof env>,body:()=>T)=>{
   const saved={...process.env};Object.assign(process.env,{...env,...overrides});
   for(const [key,value] of Object.entries({...env,...overrides})) if(value===undefined) delete process.env[key];
   resetIntegrationsConfig();
   try{return body();}finally{process.env=saved;resetIntegrationsConfig();}
  };
  // A legacy seal written before the keyring still opens (duplicate decryptNetworkingCode removed).
  expect(run({},()=>openNetworkingCode(payload))).toBe("123456");
  const v1=new NetworkingKeyring({keys:[{kid:"k1",secret:k1}],legacySecret:secret,writeV1:true}).seal("654321");
  expect(v1).toMatch(/^v1:k1:/);
  expect(run({NETWORKING_KEYS:`k1:${k1}`},()=>openNetworkingCode(v1))).toBe("654321");
  expect(run({NETWORKING_KEYS:`k1:${k1}`},()=>openNetworkingCode(payload))).toBe("123456");
  expect(()=>run({},()=>openNetworkingCode(v1))).toThrow("k1");
  expect(()=>run({NETWORKING_TOKEN_SECRET:"another-secret-at-least-32-characters"},()=>openNetworkingCode(payload))).toThrow();
  encrypted[0]=encrypted[0]!^1;
  const tampered=[iv,cipher.getAuthTag(),encrypted].map(value=>value.toString("base64url")).join(".");
  expect(()=>run({},()=>openNetworkingCode(tampered))).toThrow();
 });
 it("escapes user-authored names, company names and template bodies",()=>{
  const startsAt=new Date("2099-04-20T08:00:00.000Z");
  const attack='<img src=x onerror="alert(1)">';
  const ctx={
   event:{slug:"demo",name:`O'Brien ${attack}`},profile:{id:"b",language:"en",firstName:"Ann"},
   config:NetworkingConfigSchema.parse({timezone:"UTC",defaultLanguage:"en",logoUrl:"https://cdn.example/logo.png"}),
   meeting:{id:"m",status:"PENDING_ALLOCATION",startsAt,endsAt:new Date(startsAt.getTime()+1_800_000),requesterId:"a",recipientId:"b",proposedStartsAt:null,proposalBy:null,message:attack,cancellationNote:"",updatedAt:startsAt,revision:1},
   table:null,contact:null,blocked:false,subscriptions:[],
  } as unknown as NetworkingNotificationContext;
  const {html}=renderNetworkingNotification("MEETING_REQUEST",{},ctx);
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain('alt="O&#039;Brien &lt;img');
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

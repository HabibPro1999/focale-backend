import "reflect-metadata";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingUploadsService } from "./networking.uploads.service";
import { NetworkingService } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingExportsService } from "./networking.exports.service";

const ctx = { event: { id: "event" }, profile: { id: "self" } };
const social = {
  connections: vi.fn(async () => ({ route: "list" })),
  connectionWith: vi.fn(async (_ctx: unknown, profileId: string) => ({ route: "with", profileId })),
  connectionSummary: vi.fn(async (_ctx: unknown, id: string) => ({ route: "one", id })),
  messages: vi.fn(async (_ctx: unknown, id: string) => ({ route: "messages", id })),
};
const meetings = {
  list: vi.fn(async () => ({ route: "meetings" })),
  get: vi.fn(async (_ctx: unknown, id: string) => ({ route: "meeting", id })),
};
@Module({
  controllers: [NetworkingPublicController],
  providers: [
    { provide: NetworkingUploadsService, useValue: {} },
    { provide: NetworkingService, useValue: { participant: async () => ctx, registrationInfo: async () => ({ enabled: false }) } },
    { provide: NetworkingSocialService, useValue: social },
    { provide: NetworkingMeetingsService, useValue: meetings },
    { provide: NetworkingExportsService, useValue: { connections: async () => "csv-body" } },
  ],
})
class RoutingModule {}

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(RoutingModule, new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(() => app?.close());

it.each([
  ["/api/networking/demo/connections/export", "csv-body"],
  ["/api/networking/demo/connections/with/profile-1", { connection: { route: "with", profileId: "profile-1" } }],
  ["/api/networking/demo/connections/connection-1", { route: "one", id: "connection-1" }],
  ["/api/networking/demo/connections/connection-1/messages", { route: "messages", id: "connection-1" }],
  ["/api/networking/demo/connections", { route: "list" }],
  ["/api/networking/demo/meetings/meeting-1", { route: "meeting", id: "meeting-1" }],
  ["/api/networking/demo/registration", { enabled: false }],
])("GET %s reaches its own handler", async (url, expected) => {
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  if (typeof expected === "string") expect(response.body).toBe(expected);
  else expect(response.json()).toEqual(expected);
});

import { Module } from "@nestjs/common";
import { EventsController } from "./events.controller";
import { EventsPublicController } from "./events.public.controller";
import { EventsService } from "./events.service";

@Module({
  controllers: [EventsController, EventsPublicController],
  providers: [EventsService],
})
export class EventsModule {}

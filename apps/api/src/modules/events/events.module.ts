import { Module } from "@nestjs/common";
import { EventsController } from "./events.controller";
import { EventsPublicController } from "./events.public.controller";
import { EventsService } from "./events.service";

@Module({
  controllers: [EventsController, EventsPublicController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}

import { Module } from "@nestjs/common";
import { RealtimeController } from "./realtime.controller";
import { RealtimeConnectionRegistry } from "./connections";
import { RealtimePumpService } from "./realtime.pump";

@Module({
  controllers: [RealtimeController],
  providers: [RealtimeConnectionRegistry, RealtimePumpService],
})
export class RealtimeModule {}

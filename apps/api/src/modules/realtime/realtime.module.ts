import { Module } from "@nestjs/common";
import { RealtimeController } from "./realtime.controller";
import { RealtimePumpService } from "./realtime.pump";

@Module({
  controllers: [RealtimeController],
  // Open streams are tracked by the global ShutdownCoordinator (CoreModule).
  providers: [RealtimePumpService],
})
export class RealtimeModule {}

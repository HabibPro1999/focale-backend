import { Module } from "@nestjs/common";
import { AccessController } from "./access.controller";
import { AccessPublicController } from "./access.public.controller";
import { AccessService } from "./access.service";

@Module({
  controllers: [AccessController, AccessPublicController],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}

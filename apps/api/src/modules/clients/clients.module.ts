import { Module } from "@nestjs/common";
import { ClientsController } from "./clients.controller";
import { ClientsService } from "./clients.service";

// Module-gate fns (assertClientModuleEnabled, assertModuleEnabledForClient,
// isModuleEnabledForClient) are plain exports in ./module-gates —
// consumer modules import them directly, no DI needed.
@Module({
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}

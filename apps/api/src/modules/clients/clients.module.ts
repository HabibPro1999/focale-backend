import { Module } from "@nestjs/common";
import { ClientsController } from "./clients.controller";
import { ClientsService } from "./clients.service";

// Module-gate fns (assertClientModuleEnabled, assertModuleEnabledForClient,
// isModuleEnabledForClient, clientExists) are plain exports in ./module-gates —
// consumer modules import them directly, no DI needed.
@Module({
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}

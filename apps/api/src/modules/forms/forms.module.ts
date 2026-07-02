import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsPublicController } from "./forms-public.controller";
import { FormsService } from "./forms.service";

@Module({
  controllers: [FormsController, FormsPublicController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}

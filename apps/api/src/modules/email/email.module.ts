import { Module } from "@nestjs/common";
import { EmailController } from "./email.controller";
import { EmailWebhookController } from "./email-webhook.controller";
import { EmailTemplateService } from "./email-template.service";
import { EmailSendService } from "./email-send.service";

@Module({
  controllers: [EmailController, EmailWebhookController],
  providers: [EmailTemplateService, EmailSendService],
  exports: [EmailTemplateService, EmailSendService],
})
export class EmailModule {}

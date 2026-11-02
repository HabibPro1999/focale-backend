import { CommitteeInviteService } from "./abstracts.committee-invite.service";
import { CommitteeEmailsService } from "./abstracts.committee-emails";
import { CommitteeInviteController } from "./abstracts.committee-invite.controller";
import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AbstractsController } from "./abstracts.controller";
import { AbstractsCommitteeController } from "./abstracts.committee.controller";
import { AbstractsPublicController } from "./abstracts.public.controller";
import { AbstractsService } from "./abstracts.service";
import { AbstractsConfigService } from "./abstracts.config.service";
import { AbstractsAdminService } from "./abstracts.admin.service";
import { AbstractsCommitteeService } from "./abstracts.committee.service";
import { AbstractsBookService } from "./abstracts.book.service";
import { AbstractsFinalFileService } from "./abstracts.final-file.service";

@Module({
  imports: [IdentityModule],
  controllers: [
    CommitteeInviteController,
    AbstractsController,
    AbstractsCommitteeController,
    AbstractsPublicController,
  ],
  providers: [
    CommitteeInviteService,
    CommitteeEmailsService,
    AbstractsService,
    AbstractsConfigService,
    AbstractsAdminService,
    AbstractsCommitteeService,
    AbstractsBookService,
    AbstractsFinalFileService,
  ],
})
export class AbstractsModule {}

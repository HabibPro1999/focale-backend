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
    AbstractsController,
    AbstractsCommitteeController,
    AbstractsPublicController,
  ],
  providers: [
    AbstractsService,
    AbstractsConfigService,
    AbstractsAdminService,
    AbstractsCommitteeService,
    AbstractsBookService,
    AbstractsFinalFileService,
  ],
})
export class AbstractsModule {}

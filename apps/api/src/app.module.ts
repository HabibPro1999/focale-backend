import { Module } from "@nestjs/common";
import { CoreModule } from "./core/core.module";
import { HealthModule } from "./modules/health/health.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { EventsModule } from "./modules/events/events.module";
import { FormsModule } from "./modules/forms/forms.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { AccessModule } from "./modules/access/access.module";
import { EmailModule } from "./modules/email/email.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { SponsorshipsModule } from "./modules/sponsorships/sponsorships.module";
import { RegistrationsModule } from "./modules/registrations/registrations.module";
import { AbstractsModule } from "./modules/abstracts/abstracts.module";
import { CertificatesModule } from "./modules/certificates/certificates.module";
import { CheckinModule } from "./modules/checkin/checkin.module";
import { ReportsModule } from "./modules/reports/reports.module";

@Module({
  imports: [
    CoreModule,
    HealthModule,
    IdentityModule,
    ClientsModule,
    EventsModule,
    FormsModule,
    PricingModule,
    AccessModule,
    EmailModule,
    RealtimeModule,
    SponsorshipsModule,
    RegistrationsModule,
    AbstractsModule,
    CertificatesModule,
    CheckinModule,
    ReportsModule,
  ],
})
export class AppModule {}

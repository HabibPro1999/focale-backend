// Public surface consumed by other domains (forms, access, registrations,
// certificates, abstracts, checkin, sponsorships, pricing, email, reports).
export { EventsModule } from "./events.module";
export {
  EventsService,
  assertEventWritable,
  assertEventOpen,
  assertEventAcceptsPublicActions,
  eventAcceptsPublicActions,
} from "./events.service";
export { EventIdParamDto, EventSlugParamDto } from "./events.dto";

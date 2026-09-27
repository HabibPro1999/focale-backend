// Public surface consumed by other domains (forms, access, registrations,
// certificates, abstracts, checkin, sponsorships, pricing, email, reports).
export { EventsModule } from "./events.module";
export { EventsService } from "./events.service";
export {
  assertEventWritable,
  assertEventOpen,
  assertEventAcceptsPublicActions,
  eventAcceptsPublicActions,
} from "./event-status";
export { EventIdParamDto, EventSlugParamDto } from "./events.dto";

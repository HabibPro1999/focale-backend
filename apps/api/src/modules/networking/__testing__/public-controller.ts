import { NetworkingPublicController } from "../networking.public.controller";
import { NetworkingService } from "../networking.service";
import { NetworkingSocialService } from "../networking.social.service";
import { NetworkingMeetingsService } from "../networking.meetings.service";
import { NetworkingExportsService } from "../networking.exports.service";
import { NetworkingUploadsService } from "../networking.uploads.service";
import { NetworkingNotificationsService } from "../networking.notifications.service";

type Providers = {
  service: NetworkingService;
  social: NetworkingSocialService;
  meetings: NetworkingMeetingsService;
  exports: NetworkingExportsService;
  uploads: NetworkingUploadsService;
  notices: NetworkingNotificationsService;
};

/**
 * The public controller over real collaborators; each test replaces only the
 * methods it exercises.
 */
export function networkingPublicController(
  overrides: { [K in keyof Providers]?: Partial<Providers[K]> } = {},
) {
  const service = Object.assign(new NetworkingService(), overrides.service);
  const social = Object.assign(
    new NetworkingSocialService(service),
    overrides.social,
  );
  const meetings = Object.assign(
    new NetworkingMeetingsService(service),
    overrides.meetings,
  );
  return new NetworkingPublicController(
    Object.assign(new NetworkingUploadsService(), overrides.uploads),
    service,
    social,
    meetings,
    Object.assign(
      new NetworkingExportsService(social, meetings),
      overrides.exports,
    ),
    Object.assign(new NetworkingNotificationsService(), overrides.notices),
  );
}

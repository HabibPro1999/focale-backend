import type { ShutdownCoordinator } from "../core/shutdown";
import { NetworkingService } from "../modules/networking/networking.service";
import { NetworkingAuthService } from "../modules/networking/networking.auth.service";
import { NetworkingProfileService } from "../modules/networking/networking.profile.service";
import { NetworkingNotificationsService } from "../modules/networking/networking.notifications.service";
import { NetworkingSocialService } from "../modules/networking/networking.social.service";
import { NetworkingMeetingsService } from "../modules/networking/networking.meetings.service";
import { NetworkingExportsService } from "../modules/networking/networking.exports.service";
import { NetworkingUploadsService } from "../modules/networking/networking.uploads.service";
import { NetworkingPublicController } from "../modules/networking/networking.public.controller";

/** Real policy and orchestration by default; callers override only their test boundary. */
export function makeNetworkingPublicController(overrides: {
  service?: Partial<NetworkingService>;
  auth?: Partial<NetworkingAuthService>;
  profiles?: Partial<NetworkingProfileService>;
  social?: Partial<NetworkingSocialService>;
  meetings?: Partial<NetworkingMeetingsService>;
  exports?: Partial<NetworkingExportsService>;
  lifecycle?: ShutdownCoordinator;
} = {}) {
  const service = Object.assign(new NetworkingService(), overrides.service);
  const social = Object.assign(new NetworkingSocialService(service), overrides.social);
  const meetings = Object.assign(new NetworkingMeetingsService(service), overrides.meetings);
  const exports = Object.assign(new NetworkingExportsService(social, meetings), overrides.exports);
  return new NetworkingPublicController(
    new NetworkingUploadsService(), service, social, meetings, exports,
    Object.assign(new NetworkingAuthService(service), overrides.auth), Object.assign(new NetworkingProfileService(service), overrides.profiles),
    new NetworkingNotificationsService(), overrides.lifecycle,
  );
}

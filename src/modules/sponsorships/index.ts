export {
  sponsorshipsRoutes,
  sponsorshipDetailRoutes,
  registrationSponsorshipsRoutes,
} from "./sponsorships.routes.js";

export {
  sponsorshipsPublicRoutes,
  sponsorshipsPublicBySlugRoutes,
} from "./sponsorships.public.routes.js";

export { calculateApplicableAmount } from "@shared/utils/sponsorship-math.js";

import {
  CreateSponsorshipBatchSchema,
  LinkSponsorshipByCodeSchema,
  LinkSponsorshipSchema,
  ListSponsorshipsQuerySchema,
  RegistrationIdParamSchema,
  RegistrationSponsorshipParamSchema,
  RegistrantSearchQuerySchema,
  SponsorshipEventIdParamSchema,
  SponsorshipEventSlugParamSchema,
  SponsorshipIdParamSchema,
  UpdateSponsorshipSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class SponsorshipEventIdParamDto extends createZodDto(
  SponsorshipEventIdParamSchema,
) {}
export class SponsorshipEventSlugParamDto extends createZodDto(
  SponsorshipEventSlugParamSchema,
) {}
export class SponsorshipIdParamDto extends createZodDto(
  SponsorshipIdParamSchema,
) {}
export class RegistrationIdParamDto extends createZodDto(
  RegistrationIdParamSchema,
) {}
export class RegistrationSponsorshipParamDto extends createZodDto(
  RegistrationSponsorshipParamSchema,
) {}
export class ListSponsorshipsQueryDto extends createZodDto(
  ListSponsorshipsQuerySchema,
) {}
export class RegistrantSearchQueryDto extends createZodDto(
  RegistrantSearchQuerySchema,
) {}
export class UpdateSponsorshipDto extends createZodDto(UpdateSponsorshipSchema) {}
export class CreateSponsorshipBatchDto extends createZodDto(
  CreateSponsorshipBatchSchema,
) {}
export class LinkSponsorshipDto extends createZodDto(LinkSponsorshipSchema) {}
export class LinkSponsorshipByCodeDto extends createZodDto(
  LinkSponsorshipByCodeSchema,
) {}

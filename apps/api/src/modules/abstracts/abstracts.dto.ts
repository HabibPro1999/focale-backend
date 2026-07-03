import {
  AbstractsEventIdParamSchema,
  ThemeIdParamSchema,
  AbstractAdminParamSchema,
  AbstractBookJobParamSchema,
  PatchConfigSchema,
  CreateThemeSchema,
  UpdateThemeSchema,
  AdditionalFieldsSchema,
  ListAbstractsQuerySchema,
  AbstractSlugParamSchema,
  AbstractIdParamSchema,
  AbstractTokenQuerySchema,
  SubmitAbstractSchema,
  EditAbstractSchema,
  FinalizeAbstractSchema,
  MarkAbstractPresentedSchema,
  CommitteeMemberParamSchema,
  AddCommitteeMemberSchema,
  SetReviewerThemesSchema,
  AssignReviewersSchema,
  CommitteeAbstractsQuerySchema,
  ReviewAbstractSchema,
  SetCommitteeMemberPasswordSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class AbstractsEventIdParamDto extends createZodDto(
  AbstractsEventIdParamSchema,
) {}
export class ThemeIdParamDto extends createZodDto(ThemeIdParamSchema) {}
export class AbstractAdminParamDto extends createZodDto(
  AbstractAdminParamSchema,
) {}
export class AbstractBookJobParamDto extends createZodDto(
  AbstractBookJobParamSchema,
) {}
export class PatchConfigDto extends createZodDto(PatchConfigSchema) {}
export class CreateThemeDto extends createZodDto(CreateThemeSchema) {}
export class UpdateThemeDto extends createZodDto(UpdateThemeSchema) {}
export class AdditionalFieldsDto extends createZodDto(AdditionalFieldsSchema) {}
export class ListAbstractsQueryDto extends createZodDto(
  ListAbstractsQuerySchema,
) {}
export class EventSlugParamDto extends createZodDto(AbstractSlugParamSchema) {}
export class AbstractIdParamDto extends createZodDto(AbstractIdParamSchema) {}
export class AbstractTokenQueryDto extends createZodDto(
  AbstractTokenQuerySchema,
) {}
export class SubmitAbstractDto extends createZodDto(SubmitAbstractSchema) {}
export class EditAbstractDto extends createZodDto(EditAbstractSchema) {}

// Union / discriminated-union bodies: createZodDto can't be *extended* when the
// schema's inferred type is a union (TS2509 — a class base must be an object
// type). These carry the static `schema` the ZodValidationPipe keys on; the
// controller casts the validated (already-parsed) body to the input type.
export class FinalizeAbstractDto {
  static schema = FinalizeAbstractSchema;
}
export class AddCommitteeMemberDto {
  static schema = AddCommitteeMemberSchema;
}
export class MarkAbstractPresentedDto extends createZodDto(
  MarkAbstractPresentedSchema,
) {}
export class CommitteeMemberParamDto extends createZodDto(
  CommitteeMemberParamSchema,
) {}
export class SetReviewerThemesDto extends createZodDto(
  SetReviewerThemesSchema,
) {}
export class AssignReviewersDto extends createZodDto(AssignReviewersSchema) {}
export class CommitteeAbstractsQueryDto extends createZodDto(
  CommitteeAbstractsQuerySchema,
) {}
export class ReviewAbstractDto extends createZodDto(ReviewAbstractSchema) {}
export class SetCommitteeMemberPasswordDto extends createZodDto(
  SetCommitteeMemberPasswordSchema,
) {}

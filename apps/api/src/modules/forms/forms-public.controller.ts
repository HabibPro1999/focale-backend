import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import {
  ErrorCodes,
  PublicFormResponseSchema,
  PublicSponsorFormResponseSchema,
} from "@app/contracts";
import type { FormWithRelations } from "@app/db";
import { ResponseContract } from "../../core/response-contract";
import { FormsService } from "./forms.service";
import { EventSlugParamDto } from "./dto";

@Controller("api/forms/public")
export class FormsPublicController {
  constructor(private readonly forms: FormsService) {}

  @Get(":slug/sponsor")
  @ResponseContract(PublicSponsorFormResponseSchema)
  async getSponsorBySlug(@Param() params: EventSlugParamDto) {
    const form = await this.forms.getSponsorFormByEventSlug(params.slug);
    if (!form) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Sponsor form not found or event not open",
      });
    }
    // Transform for public consumption (startDate→startsAt, endDate→endsAt,
    // access→accessItems).
    return {
      id: form.id,
      formId: form.id, // ponytail: kept for back-compat with older form-app builds
      eventId: form.event.id,
      schemaVersion: form.schemaVersion,
      schema: form.schema,
      event: {
        id: form.event.id,
        name: form.event.name,
        slug: form.event.slug,
        status: form.event.status,
        startsAt: form.event.startDate?.toISOString() ?? null,
        endsAt: form.event.endDate?.toISOString() ?? null,
        location: form.event.location,
        bannerUrl: form.event.bannerUrl,
        client: form.event.client,
      },
      pricing: form.event.pricing,
      accessItems: form.event.access,
    };
  }

  @Get(":slug")
  @ResponseContract(PublicFormResponseSchema)
  async getBySlug(@Param() params: EventSlugParamDto) {
    const form = await this.forms.getFormByEventSlug(params.slug);
    if (!form) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "Form not found or not published",
      });
    }
    return toPublicForm(form);
  }
}

/** The form row as the form app reads it: the event's `clientId` stays internal. */
function toPublicForm(form: FormWithRelations) {
  const { clientId, ...event } = form.event;
  return { ...form, event };
}

import {
  CreateEventSchema,
  UpdateEventSchema,
  ListEventsQuerySchema,
  EventIdParamSchema,
  EventSlugParamSchema,
} from "@app/contracts";
import { createZodDto } from "../../core/zod";

export class CreateEventDto extends createZodDto(CreateEventSchema) {}
export class UpdateEventDto extends createZodDto(UpdateEventSchema) {}
export class ListEventsQueryDto extends createZodDto(ListEventsQuerySchema) {}
export class EventIdParamDto extends createZodDto(EventIdParamSchema) {}
export class EventSlugParamDto extends createZodDto(EventSlugParamSchema) {}

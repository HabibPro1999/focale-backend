import { networkingValidation } from "./networking.errors";
import { NetworkingConfigSchema, type NetworkingConfig } from "@app/contracts";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { getActiveEventAccessId, networkingFormField, type NetworkingStore, type DbExecutor } from "@app/db";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { networkingSlots, zonedInstant } from "./networking.policy";
const CONSENT_FIELD_TYPES = ["checkbox", "radio", "dropdown", "select"];

/** Validation and DB reads deliberately remain in the original order. */
export async function assertValidNetworkingConfig(
  merged: unknown, changes: Partial<NetworkingConfig>, eventId: string, store: NetworkingStore, db: DbExecutor,
) {
  const invalid = networkingValidation;
  const parsed = NetworkingConfigSchema.safeParse(merged);
  if (!parsed.success) throw invalid("Invalid networking configuration", parsed.error.flatten());
  const config = parsed.data;
  if (!config.languages.includes(config.defaultLanguage))
    throw invalid("Default language must be enabled");
  if ([config.opensAt, config.closesAt, ...config.blackoutSlots].some(
    (value) => value != null && !Number.isFinite(Date.parse(value)),
  )) throw invalid("Invalid networking date");
  if (config.opensAt && config.closesAt && Date.parse(config.opensAt) >= Date.parse(config.closesAt))
    throw invalid("Closing date must follow opening date");
  const event = await store.one("events", { id: eventId });
  if (!event) throw new NotFoundException("Event not found");
  if (config.openingHours.some((window) => {
    let start: number, end: number;
    try {
      start = zonedInstant(window.date, window.start, config.timezone).getTime();
      end = zonedInstant(window.date, window.end, config.timezone).getTime();
    } catch {
      throw invalid("Invalid meeting opening hours");
    }
    return !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
      start < event.startDate.getTime() || end > event.endDate.getTime();
  }))
    throw invalid("Meeting opening hours must be within the event dates");
  if (
    config.requiredAccessId &&
    !(await getActiveEventAccessId(config.requiredAccessId, eventId, db))
  )
    throw invalid("Networking area access must be active and belong to this event");
  const consentFieldId = config.fieldMapping.consent;
  if ("fieldMapping" in changes && consentFieldId) {
    const field = (await store.all("forms", { eventId }))
      .map((form) => networkingFormField(form.schema, consentFieldId))
      .find(Boolean);
    if (!field || !CONSENT_FIELD_TYPES.includes(String(field.type)))
      throw invalid("Consent mapping must point to a checkbox, radio or select field of the registration form");
  }
  if (config.enabled) {
    await assertClientModuleEnabled(event.clientId, "registrations", db);
    await assertClientModuleEnabled(event.clientId, "emails", db);
    if (config.meetingsEnabled && !config.openingHours.length)
      throw invalid("Configure meeting opening hours before activating meetings");
  }
  const meetings = await store.all("meetings", { eventId });
  const valid = new Set(networkingSlots(config, event));
  if (
    meetings.some(
      (v) =>
        ["CONFIRMED", "PENDING_ALLOCATION"].includes(v.status) &&
        v.endsAt > new Date() &&
        (!valid.has(v.startsAt.toISOString()) ||
          v.endsAt.getTime() - v.startsAt.getTime() !==
            config.slotDurationMinutes * 60_000),
    )
  )
    throw new ConflictException(
      "Existing appointments conflict with the proposed opening hours or duration",
    );
  return config;
}

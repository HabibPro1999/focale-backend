import { ConflictException, NotFoundException } from "@nestjs/common";
import { ErrorCodes, NetworkingConfigSchema, type NetworkingConfig } from "@app/contracts";
import { getActiveEventAccessId, networkingFormField, networkingMeetingIs, networkingRetentionEnded, type DbExecutor, type NetworkingRow, type NetworkingStore } from "@app/db";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { networkingSlots, zonedInstant } from "./networking.policy";
import { networkingValidation } from "./networking.errors";

const CONSENT_FIELD_TYPES = ["checkbox", "radio", "dropdown", "select"];

/** Parse and check the config in the original order, on the caller's executor. */
export async function validateNetworkingConfig({ eventId, current, changes, store, db }: {
  eventId: string;
  current: NetworkingRow<"configs"> | null;
  changes: Partial<NetworkingConfig>;
  store: NetworkingStore;
  db: DbExecutor;
}) {
  const invalid = networkingValidation;
  const parsed = NetworkingConfigSchema.safeParse({ ...current?.config, ...changes });
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
  // Re-enabling after retention would let registration sync copy personal data back
  // in; once the purge has started, the event can never be enabled again.
  if (
    config.enabled &&
    (current?.purgeStartedAt ||
      (current?.config?.enabled !== true && networkingRetentionEnded(event.endDate, config.retentionDays)))
  )
    throw new ConflictException({
      code: ErrorCodes.NETWORKING_RETENTION_ENDED,
      message: "The networking retention period of this event has ended; it cannot be enabled again",
    });
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
        networkingMeetingIs(v.status, "accepted") &&
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

import { assertEventWritable, VALID_STATUS_TRANSITIONS } from "./event-status";
import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import type {
  CreateEventInput,
  UpdateEventInput,
  ListEventsQuery,
  PublicPaymentConfigResponse,
} from "@app/contracts";
import { paginate, type PaginatedResult } from "@app/shared";
import {
  getDb,
  withSerializableTxn,
  type EventRow,
  type EventWithPricing,
  clientExistsById,
  countRegistrationsTx,
  deleteEmailTemplatesByEventTx,
  deleteEventTx,
  getAbstractBookStorageKeysTx,
  getAbstractFinalFileKeysTx,
  getCertificateTemplateUrlsTx,
  getEventIdBySlugTx,
  getEventWithPricing,
  getEventWithPricingAndClient,
  getEventWithRegistrationCountTx,
  getNetworkingConfig,
  insertEventPricingTx,
  insertEventTx,
  listEvents as listEventsQuery,
  updateEventBannerUrl,
  updateEventTx,
  upsertEventPricingTx,
} from "@app/db";
import {
  compressImage,
  extractStorageKeyFromUrl,
  getStorageProvider,
  ownedStorageKey,
} from "@app/integrations";
import { fileTypeFromBuffer } from "file-type";
import { notFound, conflict, badRequest, orNotFound } from "../../core/app-exception";
import { logger } from "../../core/logger.service";
import { isModuleEnabledForClient } from "../clients/module-gates";

function normalizeBasePrice(basePrice: number | null | undefined): number {
  return basePrice ?? 0;
}

function normalizeCurrency(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() ?? "TND";
}

// --- Storage cleanup helpers (best-effort; failures only logged) ------------

async function deleteStoredObjectBestEffort(
  location: string | null | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  if (!location) return;
  const key = extractStorageKeyFromUrl(location);
  if (!key) return;
  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    logger.warn({ err, key, ...context }, "Failed to delete stored event file");
  }
}

function eventHasRegistrationsMessage(count: number): string {
  return `Cannot delete event with ${count} registration(s). Archive the event instead.`;
}

// pg foreign-key violation (Prisma P2003 equivalent).
function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "23503";
}

@Injectable()
export class EventsService {
  /** Create Event + EventPricing atomically. */
  async createEvent(input: CreateEventInput): Promise<EventWithPricing> {
    const {
      clientId,
      name,
      slug,
      description,
      maxCapacity,
      startDate,
      endDate,
      location,
      basePrice,
      currency,
    } = input;

    if (!(await clientExistsById(clientId))) {
      throw notFound("Client not found");
    }

    if ((await getEventIdBySlugTx(getDb(), slug)) !== null) {
      throw conflict("Event with this slug already exists");
    }

    return getDb().transaction(
      async (tx) => {
        const event = await insertEventTx(tx, {
          clientId,
          name,
          slug,
          description: description ?? null,
          maxCapacity: maxCapacity ?? null,
          startDate,
          endDate,
          location: location ?? null,
          status: "CLOSED",
        });
        const pricing = await insertEventPricingTx(tx, {
          eventId: event.id,
          basePrice: normalizeBasePrice(basePrice),
          currency: normalizeCurrency(currency),
        });
        return { ...event, pricing };
      },
      { isolationLevel: "read committed" },
    );
  }

  getEventById(id: string): Promise<EventWithPricing | null> {
    return getEventWithPricing(id);
  }

  /** Update event (+pricing). Serializable + retry — currency guard runs inside the txn. */
  async updateEvent(id: string, input: UpdateEventInput): Promise<EventWithPricing> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw badRequest("At least one field must be provided for update");
    }

    const { basePrice, currency, ...eventData } = input;
    const hasEventData = Object.values(eventData).some((v) => v !== undefined);

    return withSerializableTxn(
      async (tx) => {
        const event = orNotFound(await getEventWithPricing(id, tx), "Event not found");

        if (input.status && input.status !== event.status) {
          const allowed = VALID_STATUS_TRANSITIONS[event.status] ?? [];
          if (!allowed.includes(input.status)) {
            throw badRequest(`Cannot transition event from ${event.status} to ${input.status}`, { code: ErrorCodes.INVALID_STATUS_TRANSITION });
          }
        }
        assertEventWritable(event);

        const resultingStart = input.startDate ?? event.startDate;
        const resultingEnd = input.endDate ?? event.endDate;
        if (resultingEnd < resultingStart) {
          throw badRequest("End date must be greater than or equal to start date");
        }

        if (
          input.maxCapacity !== undefined &&
          input.maxCapacity !== null &&
          input.maxCapacity < event.registeredCount
        ) {
          throw badRequest("Max capacity cannot be below current registered count");
        }

        if (input.slug && input.slug !== event.slug) {
          const existingId = await getEventIdBySlugTx(tx, input.slug);
          if (existingId) {
            throw conflict("Event with this slug already exists");
          }
        }

        const normalizedCurrency =
          currency !== undefined ? normalizeCurrency(currency) : undefined;
        if (normalizedCurrency !== undefined) {
          const currentCurrency = event.pricing?.currency ?? "TND";
          if (normalizedCurrency !== currentCurrency) {
            const registrationCount = await countRegistrationsTx(tx, id);
            if (registrationCount > 0) {
              throw badRequest("Cannot change currency after registrations exist");
            }
          }
        }

        if (hasEventData) {
          await updateEventTx(tx, id, eventData);
        }

        if (basePrice !== undefined || normalizedCurrency !== undefined) {
          const pricingData: { basePrice?: number; currency?: string } = {};
          if (basePrice !== undefined) pricingData.basePrice = normalizeBasePrice(basePrice);
          if (normalizedCurrency !== undefined) pricingData.currency = normalizedCurrency;
          await upsertEventPricingTx(tx, id, pricingData);
        }
        return (await getEventWithPricing(id, tx)) as EventWithPricing;
      },
    );
  }

  async listEvents(query: ListEventsQuery): Promise<PaginatedResult<EventRow>> {
    const { page, limit, clientId, status, search } = query;
    const { data, total } = await listEventsQuery({
      page,
      limit,
      clientId,
      status,
      search,
    });
    return paginate(data, total, { page, limit });
  }

  /** Delete event. Blocked when registrations exist; storage cleanup is best-effort. */
  async deleteEvent(id: string): Promise<void> {
    let filesToDelete: {
      bannerUrl: string | null;
      certificateTemplateImages: Array<{ templateUrl: string }>;
      abstractFinalFiles: Array<{ finalFileKey: string | null }>;
      abstractBookFiles: Array<{ storageKey: string | null }>;
      networkingLogoKey: string | null;
    };

    try {
      filesToDelete = await getDb().transaction(
        async (tx) => {
          const found = await getEventWithRegistrationCountTx(tx, id);
          if (!found) {
            throw notFound("Event not found");
          }
          if (found.registrations > 0) {
            throw conflict(eventHasRegistrationsMessage(found.registrations), { code: ErrorCodes.EVENT_HAS_REGISTRATIONS });
          }

          const certificateTemplateImages = await getCertificateTemplateUrlsTx(tx, id);
          const abstractFinalFiles = await getAbstractFinalFileKeysTx(tx, id);
          const abstractBookFiles = await getAbstractBookStorageKeysTx(tx, id);
          // Only the organizer-uploaded branding object is owned; an external logo URL is never deleted.
          const networkingLogoKey = ownedStorageKey(
            (await getNetworkingConfig(id, tx)).logoUrl,
            `networking/${id}/branding`,
          );

          await deleteEmailTemplatesByEventTx(tx, id);
          await deleteEventTx(tx, id);

          return {
            bannerUrl: found.event.bannerUrl,
            certificateTemplateImages,
            abstractFinalFiles,
            abstractBookFiles,
            networkingLogoKey,
          };
        },
        { isolationLevel: "read committed" },
      );
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        const registrationCount = await countRegistrationsTx(getDb(), id);
        if (registrationCount > 0) {
          throw conflict(eventHasRegistrationsMessage(registrationCount), { code: ErrorCodes.EVENT_HAS_REGISTRATIONS });
        }
      }
      throw err;
    }

    await Promise.all([
      deleteStoredObjectBestEffort(filesToDelete.bannerUrl, { eventId: id }),
      ...filesToDelete.certificateTemplateImages.map((t) =>
        deleteStoredObjectBestEffort(t.templateUrl, { eventId: id }),
      ),
      ...filesToDelete.abstractFinalFiles.map((a) =>
        deleteStoredObjectBestEffort(a.finalFileKey, { eventId: id }),
      ),
      ...filesToDelete.abstractBookFiles.map((j) =>
        deleteStoredObjectBestEffort(j.storageKey, { eventId: id }),
      ),
      deleteStoredObjectBestEffort(filesToDelete.networkingLogoKey, { eventId: id }),
    ]);
  }

  /** Upload + store a banner image (WebP), replacing the old one best-effort. */
  async uploadEventBanner(
    id: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<{ bannerUrl: string }> {
    const event = orNotFound(await getEventWithPricing(id), "Event not found");

    assertEventWritable(event);

    const detectedType = await fileTypeFromBuffer(file.buffer);
    if (!detectedType?.mime.startsWith("image/")) {
      throw badRequest("Invalid file content. Only real images are allowed.", { code: ErrorCodes.INVALID_FILE_TYPE });
    }

    const compressed = await compressImage(file.buffer);
    const key = `${id}/banner/${crypto.randomUUID()}.webp`;
    const bannerUrl = await getStorageProvider().uploadPublic(
      compressed.buffer,
      key,
      "image/webp",
    );

    try {
      await updateEventBannerUrl(id, bannerUrl);
    } catch (err) {
      await deleteStoredObjectBestEffort(bannerUrl, { eventId: id });
      throw err;
    }

    await deleteStoredObjectBestEffort(event.bannerUrl, { eventId: id });

    return { bannerUrl };
  }

  /** Public payment-config projection. 404 hides closed / inactive-client events. */
  async getPaymentConfig(id: string): Promise<PublicPaymentConfigResponse> {
    const event = await getEventWithPricingAndClient(id);
    if (!event) {
      throw notFound("Event not found");
    }
    if (event.status !== "OPEN" || event.client.active !== true) {
      throw notFound("Event not found");
    }

    const pricing = event.pricing;
    const registrationsEnabled = isModuleEnabledForClient(event.client, "registrations");
    const pricingEnabled = isModuleEnabledForClient(event.client, "pricing");
    const paymentMethods: string[] = [];
    const exposePaymentConfig =
      registrationsEnabled && pricingEnabled;
    if (exposePaymentConfig) {
      paymentMethods.push("BANK_TRANSFER");
      if (pricing?.onlinePaymentEnabled && pricing.onlinePaymentUrl) {
        paymentMethods.push("ONLINE");
      }
      if (pricing?.cashPaymentEnabled) {
        paymentMethods.push("CASH");
      }
    }

    const sponsorshipsAvailableForActiveClient = isModuleEnabledForClient(
      event.client,
      "sponsorships",
    );

    if (exposePaymentConfig && !sponsorshipsAvailableForActiveClient) {
      paymentMethods.push("LAB_SPONSORSHIP");
    }

    return {
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        description: event.description,
        status: event.status,
        startDate: event.startDate,
        endDate: event.endDate,
        location: event.location,
        bannerUrl: event.bannerUrl,
        client: {
          id: event.client.id,
          name: event.client.name,
          logo: event.client.logo,
          primaryColor: event.client.primaryColor,
          phone: event.client.phone,
        },
      },
      sponsorshipsEnabled: sponsorshipsAvailableForActiveClient,
      pricing:
        pricing && pricingEnabled && registrationsEnabled
          ? {
              basePrice: pricing.basePrice,
              currency: pricing.currency,
              rules: pricing.rules ?? [],
              paymentMethods,
              bankDetails:
                exposePaymentConfig && pricing.bankName
                  ? {
                      bankName: pricing.bankName,
                      accountName: pricing.bankAccountName ?? "",
                      iban: pricing.bankAccountNumber ?? "",
                      bic: "",
                    }
                  : null,
              onlinePaymentUrl: exposePaymentConfig
                ? (pricing.onlinePaymentUrl ?? null)
                : null,
            }
          : null,
    };
  }
}

import crypto from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import type {
  CreateEventInput,
  UpdateEventInput,
  ListEventsQuery,
  PublicPaymentConfigResponse,
} from "@app/contracts";
import { UserRole } from "@app/contracts";
import { paginate, type PaginatedResult } from "@app/shared";
import {
  getDb,
  type DbExecutor,
  type EventRow,
  type EventWithPricing,
  type ClientPublicFields,
  casDecrementRegisteredTx,
  casIncrementRegisteredTx,
  clientExistsById,
  countRegistrationsTx,
  deleteEmailTemplatesByEventTx,
  deleteEventTx,
  eventExists as eventExistsQuery,
  getAbstractBookStorageKeysTx,
  getAbstractFinalFileKeysTx,
  getCertificateTemplateUrlsTx,
  getEventCounterInfoTx,
  getEventIdBySlugTx,
  getEventWithPricing,
  getEventWithPricingBySlug,
  getEventWithPricingAndClient,
  getEventWithRegistrationCountTx,
  insertEventPricingTx,
  insertEventTx,
  listEvents as listEventsQuery,
  updateEventBannerUrl,
  updateEventTx,
  upsertEventPricingTx,
} from "@app/db";
import { compressImage, getStorageProvider } from "@app/integrations";
import { fileTypeFromBuffer } from "file-type";
import { logger } from "../../core/logger.service";

/** HttpException carrying the wire error shape the global filter renders verbatim. */
function appError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): HttpException {
  return new HttpException(
    details === undefined ? { code, message } : { code, message, details },
    status,
  );
}

// The 8-field auth user the (future real) AuthGuard attaches to the request.
// Interface pinned by port conventions; role is numeric.
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: number;
  clientId: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Ownership check — SUPER_ADMIN always; CLIENT_ADMIN only own client; everyone
 * else (incl. SCIENTIFIC_COMMITTEE / unknown) denied (fail-closed).
 * ponytail: kept local; belongs in a shared auth util once that wave lands.
 */
export function canAccessClient(user: AuthUser, clientId: string): boolean {
  if (user.role === UserRole.SUPER_ADMIN) return true;
  if (user.role === UserRole.CLIENT_ADMIN) return user.clientId === clientId;
  return false;
}

/** Module gate: client active AND enabledModules includes the module id. */
export function isModuleEnabledForClient(
  client: Pick<ClientPublicFields, "active" | "enabledModules">,
  moduleId: string,
): boolean {
  return client.active === true && (client.enabledModules ?? []).includes(moduleId);
}

// --- Pure event-status policy (consumed by other modules) -------------------

function normalizeBasePrice(basePrice: number | null | undefined): number {
  return basePrice ?? 0;
}

function normalizeCurrency(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() ?? "TND";
}

function effectivePublicEndDate(endDate: Date): Date {
  if (
    endDate.getUTCHours() !== 0 ||
    endDate.getUTCMinutes() !== 0 ||
    endDate.getUTCSeconds() !== 0 ||
    endDate.getUTCMilliseconds() !== 0
  ) {
    return endDate;
  }
  const inclusiveEnd = new Date(endDate);
  inclusiveEnd.setUTCHours(23, 59, 59, 999);
  return inclusiveEnd;
}

export function assertEventWritable(event: { status: string }): void {
  if (event.status === "ARCHIVED") {
    throw appError(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      "Archived events cannot be modified",
      400,
    );
  }
}

export function assertEventOpen(event: { status: string }): void {
  if (event.status !== "OPEN") {
    throw appError(
      ErrorCodes.EVENT_NOT_OPEN,
      "Event is not accepting public actions",
      400,
    );
  }
}

export function assertEventAcceptsPublicActions(
  event: { status: string; endDate: Date },
  now = new Date(),
): void {
  assertEventOpen(event);
  if (effectivePublicEndDate(event.endDate) < now) {
    throw appError(
      ErrorCodes.EVENT_NOT_OPEN,
      "Event is not accepting public actions",
      400,
    );
  }
}

// Valid event status transitions: CLOSED -> OPEN -> ARCHIVED (terminal).
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  CLOSED: ["OPEN"],
  OPEN: ["CLOSED", "ARCHIVED"],
  ARCHIVED: [],
};

// --- Serializable retry (port of withTxnRetry; db package helper is absent) --
// Retry only on CockroachDB serialization failures / deadlocks (40001 / 40P01).
function isSerializationFailure(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "40001" || code === "40P01";
}

async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  const maxAttempts = 5;
  const baseDelayMs = 25;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= maxAttempts) throw error;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = backoff + Math.floor(Math.random() * backoff * 0.5);
      logger.warn({ attempt, maxAttempts, delay, label }, "Serialization failure; retrying transaction");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// --- Storage cleanup helpers (best-effort; failures only logged) ------------

function extractKeyFromStorage(value: string): string | null {
  if (!value.includes("://")) {
    return value || null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

async function deleteStoredObjectBestEffort(
  location: string | null | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  if (!location) return;
  const key = extractKeyFromStorage(location);
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
      throw appError(ErrorCodes.NOT_FOUND, "Client not found", 404);
    }

    if ((await getEventIdBySlugTx(getDb(), slug)) !== null) {
      throw appError(ErrorCodes.CONFLICT, "Event with this slug already exists", 409);
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

  getEventBySlug(slug: string): Promise<EventWithPricing | null> {
    return getEventWithPricingBySlug(slug);
  }

  eventExists(id: string): Promise<boolean> {
    return eventExistsQuery(id);
  }

  /** Update event (+pricing). Serializable + retry — currency guard runs inside the txn. */
  async updateEvent(id: string, input: UpdateEventInput): Promise<EventWithPricing> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw appError(
        ErrorCodes.VALIDATION_ERROR,
        "At least one field must be provided for update",
        400,
      );
    }

    const { basePrice, currency, ...eventData } = input;
    const hasEventData = Object.values(eventData).some((v) => v !== undefined);

    return withSerializableRetry(
      () =>
        getDb().transaction(
          async (tx) => {
            const event = await getEventWithPricing(id, tx);
            if (!event) {
              throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
            }

            if (input.status && input.status !== event.status) {
              const allowed = VALID_STATUS_TRANSITIONS[event.status] ?? [];
              if (!allowed.includes(input.status)) {
                throw appError(
                  ErrorCodes.INVALID_STATUS_TRANSITION,
                  `Cannot transition event from ${event.status} to ${input.status}`,
                  400,
                );
              }
            }
            assertEventWritable(event);

            const resultingStart = input.startDate ?? event.startDate;
            const resultingEnd = input.endDate ?? event.endDate;
            if (resultingEnd < resultingStart) {
              throw appError(
                ErrorCodes.VALIDATION_ERROR,
                "End date must be greater than or equal to start date",
                400,
              );
            }

            if (
              input.maxCapacity !== undefined &&
              input.maxCapacity !== null &&
              input.maxCapacity < event.registeredCount
            ) {
              throw appError(
                ErrorCodes.VALIDATION_ERROR,
                "Max capacity cannot be below current registered count",
                400,
              );
            }

            if (input.slug && input.slug !== event.slug) {
              const existingId = await getEventIdBySlugTx(tx, input.slug);
              if (existingId) {
                throw appError(
                  ErrorCodes.CONFLICT,
                  "Event with this slug already exists",
                  409,
                );
              }
            }

            const normalizedCurrency =
              currency !== undefined ? normalizeCurrency(currency) : undefined;
            if (normalizedCurrency !== undefined) {
              const currentCurrency = event.pricing?.currency ?? "TND";
              if (normalizedCurrency !== currentCurrency) {
                const registrationCount = await countRegistrationsTx(tx, id);
                if (registrationCount > 0) {
                  throw appError(
                    ErrorCodes.VALIDATION_ERROR,
                    "Cannot change currency after registrations exist",
                    400,
                  );
                }
              }
            }

            if (hasEventData) {
              await updateEventTx(tx, id, eventData);
            }

            if (basePrice === undefined && normalizedCurrency === undefined) {
              return (await getEventWithPricing(id, tx)) as EventWithPricing;
            }

            const pricingData: { basePrice?: number; currency?: string } = {};
            if (basePrice !== undefined) {
              pricingData.basePrice = normalizeBasePrice(basePrice);
            }
            if (normalizedCurrency !== undefined) {
              pricingData.currency = normalizedCurrency;
            }

            await upsertEventPricingTx(tx, id, pricingData);

            return (await getEventWithPricing(id, tx)) as EventWithPricing;
          },
          { isolationLevel: "serializable" },
        ),
      "updateEvent",
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
    };

    try {
      filesToDelete = await getDb().transaction(
        async (tx) => {
          const found = await getEventWithRegistrationCountTx(tx, id);
          if (!found) {
            throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
          }
          if (found.registrations > 0) {
            throw appError(
              ErrorCodes.EVENT_HAS_REGISTRATIONS,
              eventHasRegistrationsMessage(found.registrations),
              409,
            );
          }

          const certificateTemplateImages = await getCertificateTemplateUrlsTx(tx, id);
          const abstractFinalFiles = await getAbstractFinalFileKeysTx(tx, id);
          const abstractBookFiles = await getAbstractBookStorageKeysTx(tx, id);

          await deleteEmailTemplatesByEventTx(tx, id);
          await deleteEventTx(tx, id);

          return {
            bannerUrl: found.event.bannerUrl,
            certificateTemplateImages,
            abstractFinalFiles,
            abstractBookFiles,
          };
        },
        { isolationLevel: "read committed" },
      );
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        const registrationCount = await countRegistrationsTx(getDb(), id);
        if (registrationCount > 0) {
          throw appError(
            ErrorCodes.EVENT_HAS_REGISTRATIONS,
            eventHasRegistrationsMessage(registrationCount),
            409,
          );
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
    ]);
  }

  /** Upload + store a banner image (WebP), replacing the old one best-effort. */
  async uploadEventBanner(
    id: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<{ bannerUrl: string }> {
    const event = await getEventWithPricing(id);
    if (!event) {
      throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventWritable(event);

    const detectedType = await fileTypeFromBuffer(file.buffer);
    if (!detectedType?.mime.startsWith("image/")) {
      throw appError(
        ErrorCodes.INVALID_FILE_TYPE,
        "Invalid file content. Only real images are allowed.",
        400,
      );
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

  /**
   * Atomic capacity-safe increment (consumed by registrations, inside its txn).
   * Fast path: guarded CAS. Miss → diagnose NOT_FOUND / EVENT_NOT_OPEN / EVENT_FULL.
   */
  async incrementRegisteredCountTx(exec: DbExecutor, id: string): Promise<void> {
    if (await casIncrementRegisteredTx(exec, id)) return;

    const info = await getEventCounterInfoTx(exec, id);
    if (!info) {
      throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (info.status !== "OPEN") {
      throw appError(
        ErrorCodes.EVENT_NOT_OPEN,
        "Event is not accepting public actions",
        400,
      );
    }
    throw appError(ErrorCodes.EVENT_FULL, "Event is at capacity", 409);
  }

  /** Atomic decrement (consumed by registrations). */
  async decrementRegisteredCountTx(exec: DbExecutor, id: string): Promise<void> {
    if (await casDecrementRegisteredTx(exec, id)) return;

    const info = await getEventCounterInfoTx(exec, id);
    if (!info) {
      throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    throw appError(
      ErrorCodes.VALIDATION_ERROR,
      "Event registered count is already zero",
      400,
    );
  }

  /** Public payment-config projection. 404 hides closed / inactive-client events. */
  async getPaymentConfig(id: string): Promise<PublicPaymentConfigResponse> {
    const event = await getEventWithPricingAndClient(id);
    if (!event) {
      throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (event.status !== "OPEN" || event.client.active !== true) {
      throw appError(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }

    const pricing = event.pricing;
    const registrationsEnabled = isModuleEnabledForClient(event.client, "registrations");
    const pricingEnabled = isModuleEnabledForClient(event.client, "pricing");
    const paymentMethods: string[] = [];
    const exposePaymentConfig =
      event.status === "OPEN" && registrationsEnabled && pricingEnabled;
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

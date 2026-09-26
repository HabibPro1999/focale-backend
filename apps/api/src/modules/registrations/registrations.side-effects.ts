import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import {
  enqueueNetworkingRegistrationCreatedSync,
  enqueueTriggeredEmailOutbox,
  casIncrementRegisteredTx,
  casDecrementRegisteredTx,
  getEventCounterInfoTx,
  insertAuditLog,
  type DbExecutor,
} from "@app/db";
import { AccessService } from "../access/access.service";
import { AppException } from "../../core/app-exception";

/**
 * What a registration write does besides its own row, inside the caller's
 * transaction: the registration audit entry, the created email, the networking
 * projection of a new registration, the paid places of a status change and the
 * event registered counter.
 */
@Injectable()
export class RegistrationSideEffects {
  constructor(private readonly access: AccessService) {}

  /**
   * The networking projection of a new registration: a
   * `networking.registration.sync` outbox row (once per registration) that
   * the worker runs after commit (plan 4.8). Changes to an existing
   * registration enqueue theirs through emitSettlementEvents.
   */
  async queueNetworkingSync(
    exec: DbExecutor,
    registration: { id: string; eventId: string },
  ): Promise<void> {
    await enqueueNetworkingRegistrationCreatedSync(exec, {
      registrationId: registration.id,
      eventId: registration.eventId,
    });
  }

  async queueRegistrationCreatedEmail(
    exec: DbExecutor,
    eventId: string,
    registration: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    },
  ): Promise<boolean> {
    return enqueueTriggeredEmailOutbox(
      exec,
      {
        trigger: "REGISTRATION_CREATED",
        eventId,
        registration: {
          id: registration.id,
          email: registration.email,
          firstName: registration.firstName ?? null,
          lastName: registration.lastName ?? null,
        },
      },
      `email:triggered:REGISTRATION_CREATED:${registration.id}`,
    );
  }

  async syncPaidCount(
    exec: DbExecutor,
    registration: { id: string; eventId: string; priceBreakdown: unknown },
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    const coveredAccessIds =
      oldStatus === "PARTIAL" || newStatus === "PARTIAL"
        ? await this.access.getAlreadyCoveredAccessIds(registration.id, exec)
        : new Set<string>();
    await this.access.syncPaidCountDelta(
      registration.eventId,
      { status: oldStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
      { status: newStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
      exec,
    );
  }

  /** Atomic event registered-count increment; mirrors legacy incrementRegisteredCountTx. */
  async incrementEventRegistered(
    exec: DbExecutor,
    eventId: string,
  ): Promise<void> {
    if (await casIncrementRegisteredTx(exec, eventId)) return;
    const info = await getEventCounterInfoTx(exec, eventId);
    if (!info) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (info.status !== "OPEN") {
      throw new AppException(
        ErrorCodes.EVENT_NOT_OPEN,
        "Event is not accepting public actions",
        400,
      );
    }
    throw new AppException(ErrorCodes.EVENT_FULL, "Event is at capacity", 409);
  }

  async decrementEventRegistered(
    exec: DbExecutor,
    eventId: string,
  ): Promise<void> {
    if (await casDecrementRegisteredTx(exec, eventId)) return;
    const info = await getEventCounterInfoTx(exec, eventId);
    if (!info) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Event registered count is already zero",
      400,
    );
  }

  audit(
    exec: DbExecutor,
    entry: {
      entityId: string;
      action: string;
      changes: Record<string, { old: unknown; new: unknown }>;
      performedBy?: string | null;
    },
  ): Promise<void> {
    return insertAuditLog(
      {
        entityType: "Registration",
        entityId: entry.entityId,
        action: entry.action,
        changes: entry.changes,
        performedBy: entry.performedBy ?? null,
      },
      exec,
    );
  }
}

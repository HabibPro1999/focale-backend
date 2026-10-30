import { prisma } from "@/database/client.js";
import { evaluateConditions } from "@shared/utils/conditions.js";
import { getExclusivityKey, getGroupedAccess } from "./access-grouping.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { AccessSelection, AccessCondition } from "./access.schema.js";
import type { EventAccess } from "@/generated/prisma/client.js";
import type { TxClient } from "@shared/types/prisma.js";

type AccessValidationDbClient = Pick<TxClient, "eventAccess">;

function hasConditions(conditions: unknown): boolean {
  return Array.isArray(conditions) && conditions.length > 0;
}

/**
 * Validate access selections for a registration.
 * Checks: mandatory included items, time conflicts, prerequisites,
 * date availability, form conditions, capacity.
 */
export async function validateAccessSelections(
  eventId: string,
  selections: AccessSelection[],
  formData: Record<string, unknown>,
  existingAccessIds?: Set<string>,
  db: AccessValidationDbClient = prisma,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const accessIds = selections.map((s) => s.accessId);
  const accessIdSet = new Set(accessIds);

  // Fetch selected items and included items in parallel
  const [accessItems, includedAccesses] = await Promise.all([
    selections.length > 0
      ? db.eventAccess.findMany({
          where: { id: { in: accessIds }, eventId },
          include: { requiredAccess: { select: { id: true } } },
        })
      : Promise.resolve([]),
    db.eventAccess.findMany({
      where: { eventId, active: true, includedInBase: true },
      select: { id: true, name: true, conditions: true, conditionLogic: true },
    }),
  ]);

  // Validate included accesses are present (before selection-specific checks)
  for (const included of includedAccesses) {
    // Skip if conditions don't match (exempt from mandatory)
    if (hasConditions(included.conditions)) {
      if (
        !evaluateConditions(
          included.conditions as AccessCondition[],
          included.conditionLogic as "AND" | "OR",
          formData,
        )
      )
        continue;
    }
    if (!accessIdSet.has(included.id)) {
      errors.push(`"${included.name}" est inclus et doit être sélectionné`);
    }
  }

  if (selections.length === 0) {
    return { valid: errors.length === 0, errors };
  }

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  // Check all selected items exist and are active (existing items are grandfathered)
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId);
    if (!access) {
      errors.push(`Access item ${selection.accessId} not found`);
    } else if (!access.active && !existingAccessIds?.has(selection.accessId)) {
      errors.push(`Access item ${selection.accessId} is inactive`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check time conflicts WITHIN EACH TYPE (items with same startsAt in same type)
  const selectionsByType = new Map<
    string,
    { access: EventAccess; selection: AccessSelection }[]
  >();

  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    const typeKey = getExclusivityKey(access);

    if (!selectionsByType.has(typeKey)) selectionsByType.set(typeKey, []);
    selectionsByType.get(typeKey)!.push({ access, selection });
  }

  for (const typeItems of selectionsByType.values()) {
    for (let i = 0; i < typeItems.length; i++) {
      for (let j = i + 1; j < typeItems.length; j++) {
        const a = typeItems[i].access;
        const b = typeItems[j].access;

        if (a.startsAt && a.endsAt && b.startsAt && b.endsAt) {
          const aStart = a.startsAt.getTime();
          const aEnd = a.endsAt.getTime();
          const bStart = b.startsAt.getTime();
          const bEnd = b.endsAt.getTime();

          if (!(aEnd <= bStart || bEnd <= aStart)) {
            errors.push(`Time conflict: "${a.name}" and "${b.name}" overlap`);
          }
        }

        // Undated items of the same exclusivity key render as one radio group,
        // so only one of them can be selected. Included-in-base items are
        // exempt (they can never be deselected), and pairs already held by the
        // registration are grandfathered.
        const bothExisting =
          existingAccessIds?.has(a.id) && existingAccessIds.has(b.id);
        if (
          a.type !== "ADDON" &&
          a.startsAt === null &&
          b.startsAt === null &&
          !a.includedInBase &&
          !b.includedInBase &&
          !bothExisting
        ) {
          errors.push(
            `Only one of "${a.name}" and "${b.name}" can be selected`,
          );
        }
      }
    }
  }

  // Check prerequisites
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      for (const req of access.requiredAccess) {
        if (!accessIdSet.has(req.id)) {
          errors.push(
            `${access.name} requires selecting its prerequisite first`,
          );
        }
      }
    }
  }

  // Check date availability and form conditions (skip for existing/grandfathered items)
  const now = new Date();
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    const isExisting = existingAccessIds?.has(selection.accessId);

    if (!isExisting) {
      if (access.availableFrom && access.availableFrom > now) {
        errors.push(`${access.name} is not yet available`);
      }
      if (access.availableTo && access.availableTo < now) {
        errors.push(`${access.name} is no longer available`);
      }
    }

    if (hasConditions(access.conditions)) {
      if (
        !evaluateConditions(
          access.conditions as AccessCondition[],
          access.conditionLogic as "AND" | "OR",
          formData,
        )
      ) {
        errors.push(
          `${access.name} is not available based on your form answers`,
        );
      }
    }
  }

  // Check capacity based on paid count (skip for existing items — they already hold spots)
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    const isExisting = existingAccessIds?.has(selection.accessId);
    if (!isExisting && access.maxCapacity !== null) {
      const spotsRemaining = access.maxCapacity - access.paidCount;
      if (spotsRemaining < selection.quantity) {
        errors.push(`${access.name} is full`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Throws ACC_7012 when the form requires an access selection, the registrant
 * made none, and something was actually selectable.
 *
 * Rule 1: satisfied as soon as one selected item is NOT `includedInBase`
 *         (auto-included pack items never count as a choice).
 * Rule 2: skipped when nothing is selectable, i.e. no visible item that is
 *         both not `includedInBase` and not full.
 *
 * Note: `getGroupedAccess` reads through the global `prisma` client, not `db`.
 * That is acceptable here — the visibility computation is read-only and does
 * not need to observe uncommitted transaction state.
 */
export async function assertAccessSelectionRequirement(
  eventId: string,
  formData: Record<string, unknown>,
  selections: AccessSelection[],
  settings: { accessSelectionRequired?: boolean } | null | undefined,
  db: AccessValidationDbClient = prisma,
): Promise<void> {
  if (settings?.accessSelectionRequired !== true) return;

  const selectedIds = selections
    .filter((s) => s.quantity > 0)
    .map((s) => s.accessId);

  if (selectedIds.length > 0) {
    const selectedItems = await db.eventAccess.findMany({
      where: { id: { in: selectedIds }, eventId },
      select: { id: true, includedInBase: true },
    });
    // Rule 1: a selection the registrant actually made satisfies the requirement.
    if (selectedItems.some((item) => !item.includedInBase)) return;
  }

  // Rule 2: skip the requirement when nothing is selectable for this registrant.
  const grouped = await getGroupedAccess(eventId, formData, selectedIds);
  const visibleItems = [
    ...grouped.groups.flatMap((group) =>
      group.slots.flatMap((slot) => slot.items),
    ),
    ...(grouped.addonGroup?.slots.flatMap((slot) => slot.items) ?? []),
  ] as Array<{ includedInBase: boolean; isFull: boolean }>;

  const selectable = visibleItems.filter(
    (item) => !item.includedInBase && !item.isFull,
  );
  if (selectable.length === 0) return;

  throw new AppError(
    "Veuillez sélectionner au moins une option",
    400,
    ErrorCodes.ACCESS_SELECTION_REQUIRED,
  );
}

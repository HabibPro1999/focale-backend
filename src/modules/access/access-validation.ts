import { prisma } from "@/database/client.js";
import { evaluateConditions } from "@shared/utils/conditions.js";
import type { AccessSelection, AccessCondition } from "./access.schema.js";
import type { EventAccess } from "@/generated/prisma/client.js";
import { getAccessTypeKey } from "@/modules/sponsorships/sponsorships.utils.js";

/**
 * Validate access selections for a registration.
 * Checks: mandatory included items, time conflicts, prerequisites,
 * date availability, form conditions, capacity.
 */
export async function validateAccessSelections(
  eventId: string,
  selections: AccessSelection[],
  formData: Record<string, unknown>,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const accessIds = selections.map((s) => s.accessId);

  // Fetch selected items and included items in parallel
  const [accessItems, includedAccesses] = await Promise.all([
    selections.length > 0
      ? prisma.eventAccess.findMany({
          where: { id: { in: accessIds }, eventId, active: true },
          include: { requiredAccess: { select: { id: true } } },
        })
      : Promise.resolve([]),
    prisma.eventAccess.findMany({
      where: { eventId, active: true, includedInBase: true },
      select: { id: true, name: true, conditions: true, conditionLogic: true },
    }),
  ]);

  // Validate included accesses are present (before selection-specific checks)
  for (const included of includedAccesses) {
    // Skip if conditions don't match (exempt from mandatory)
    if (included.conditions) {
      if (
        !evaluateConditions(
          included.conditions as AccessCondition[],
          included.conditionLogic as "AND" | "OR",
          formData,
        )
      )
        continue;
    }
    if (!accessIds.includes(included.id)) {
      errors.push(`"${included.name}" est inclus et doit être sélectionné`);
    }
  }

  if (selections.length === 0) {
    return { valid: errors.length === 0, errors };
  }

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));

  // Check all selected items exist
  for (const selection of selections) {
    if (!accessMap.has(selection.accessId)) {
      errors.push(`Access item ${selection.accessId} not found or inactive`);
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
    const typeKey = getAccessTypeKey(access.type, access.groupLabel);

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
      }
    }
  }

  // Check prerequisites
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      for (const req of access.requiredAccess) {
        if (!accessIds.includes(req.id)) {
          errors.push(
            `${access.name} requires selecting its prerequisite first`,
          );
        }
      }
    }
  }

  // Check date availability and form conditions
  const now = new Date();
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;

    if (access.availableFrom && access.availableFrom > now) {
      errors.push(`${access.name} is not yet available`);
    }
    if (access.availableTo && access.availableTo < now) {
      errors.push(`${access.name} is no longer available`);
    }

    if (access.conditions) {
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

  // Check capacity (without reserving)
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.maxCapacity !== null) {
      const spotsRemaining = access.maxCapacity - access.registeredCount;
      if (spotsRemaining < selection.quantity) {
        errors.push(`${access.name} is full`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

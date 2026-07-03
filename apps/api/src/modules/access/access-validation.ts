import { evaluateConditions, type Condition } from "@app/shared";
import type { EventAccessWithPrereqIds } from "@app/db";
import type { AccessSelection } from "@app/contracts";

type IncludedAccess = {
  id: string;
  name: string;
  conditions: unknown;
  conditionLogic: string;
};

function hasConditions(conditions: unknown): boolean {
  return Array.isArray(conditions) && conditions.length > 0;
}

/**
 * Pure selection validator. Never throws for business-rule failures — accumulates
 * them in `errors`. Order: mandatory-included → existence/active (short-circuits)
 * → time conflicts within type → prerequisites → date/conditions → capacity
 * (paidCount-gated). `existingAccessIds` grandfathers items already on a
 * registration (skip inactive/availability/capacity, still enforce conditions).
 * Callers pass already-fetched selected + includedInBase rows.
 */
export function validateSelections(
  selectedItems: EventAccessWithPrereqIds[],
  includedAccesses: IncludedAccess[],
  selections: AccessSelection[],
  formData: Record<string, unknown>,
  existingAccessIds: Set<string> | undefined,
  now: Date,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const accessIds = selections.map((s) => s.accessId);
  const accessIdSet = new Set(accessIds);

  // Mandatory included items (runs even when selections is empty).
  for (const included of includedAccesses) {
    if (hasConditions(included.conditions)) {
      if (
        !evaluateConditions(
          included.conditions as Condition[],
          included.conditionLogic,
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

  const accessMap = new Map(selectedItems.map((a) => [a.id, a]));

  // Existence + active (existing items grandfathered). Short-circuits on any error.
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

  // Time conflicts within each type (OTHER further keyed by groupLabel).
  const selectionsByType = new Map<
    string,
    { access: EventAccessWithPrereqIds; selection: AccessSelection }[]
  >();
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    const typeKey =
      access.type === "OTHER" ? `OTHER:${access.groupLabel || ""}` : access.type;
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

  // Prerequisites must also be selected.
  for (const selection of selections) {
    const access = accessMap.get(selection.accessId)!;
    if (access.requiredAccess && access.requiredAccess.length > 0) {
      for (const req of access.requiredAccess) {
        if (!accessIdSet.has(req.id)) {
          errors.push(`${access.name} requires selecting its prerequisite first`);
        }
      }
    }
  }

  // Date availability + form conditions (availability skipped for existing items).
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
          access.conditions as Condition[],
          access.conditionLogic,
          formData,
        )
      ) {
        errors.push(`${access.name} is not available based on your form answers`);
      }
    }
  }

  // Capacity based on paidCount (skipped for existing items).
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

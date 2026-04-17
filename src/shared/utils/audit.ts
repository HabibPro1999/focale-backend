import { prisma } from "@/database/client.js";
import { toInputJson } from "./json.js";

type AuditLogClient = {
  auditLog: Pick<typeof prisma.auditLog, "create">;
};

export interface AuditLogData {
  entityType: string;
  entityId: string;
  action: string;
  changes?: Record<string, { old: unknown; new: unknown }>;
  performedBy?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create an audit log entry. Accepts the bare prisma singleton, a transaction
 * client, or any narrowed client that exposes `auditLog.create` (e.g. the
 * scoped DB clients in access.service.ts).
 */
export async function auditLog(
  client: AuditLogClient,
  data: AuditLogData,
): Promise<void> {
  await client.auditLog.create({
    data: {
      entityType: data.entityType,
      entityId: data.entityId,
      action: data.action,
      changes: data.changes ? toInputJson(data.changes) : undefined,
      performedBy: data.performedBy ?? null,
      ipAddress: data.ipAddress ?? null,
      userAgent: data.userAgent ?? null,
    },
  });
}

/**
 * Calculate changes between old and new objects for the given fields.
 * Uses JSON serialization for deep equality so objects and arrays compare correctly.
 * Returns undefined when no changes are detected.
 */
export function diffChanges<T extends Record<string, unknown>>(
  old: T | null,
  updated: T,
  fields: (keyof T)[],
): Record<string, { old: unknown; new: unknown }> | undefined {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  for (const field of fields) {
    const oldVal = old?.[field];
    const newVal = updated[field];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[field as string] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

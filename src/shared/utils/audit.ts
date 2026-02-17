import { prisma } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";

// Type for Prisma transaction client
type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

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
 * Create an audit log entry.
 * Can be used with or without a transaction.
 */
export async function auditLog(
  txOrPrisma: TxClient | typeof prisma,
  data: AuditLogData,
): Promise<void> {
  await txOrPrisma.auditLog.create({
    data: {
      entityType: data.entityType,
      entityId: data.entityId,
      action: data.action,
      changes: data.changes as Prisma.InputJsonValue | undefined,
      performedBy: data.performedBy ?? null,
      ipAddress: data.ipAddress ?? null,
      userAgent: data.userAgent ?? null,
    },
  });
}

/**
 * Calculate changes between old and new objects for specified fields.
 * Returns undefined if no changes detected.
 * Uses JSON.stringify for comparison to handle objects/arrays correctly.
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
    // Use JSON.stringify for deep comparison (handles JSONB/object fields)
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[field as string] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

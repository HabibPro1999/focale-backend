import { prisma } from "@/database/client.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { TxClient } from "@shared/types/prisma.js";

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
 * Create an audit log entry inside or outside a transaction.
 *
 * @param client - Prisma transaction client (tx) or the bare prisma singleton
 * @param data   - Audit log payload
 */
export async function auditLog(
  client: TxClient | typeof prisma,
  data: AuditLogData,
): Promise<void> {
  await client.auditLog.create({
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

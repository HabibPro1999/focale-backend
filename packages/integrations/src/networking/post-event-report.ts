import {
  networkingPostEventReportData,
  saveNetworkingPostEventReport,
  refreshNetworkingDeliveryLease,
  updateNetworkingDelivery,
  type NetworkingDeliveryRow,
} from "@app/db";
import { generateNetworkingPostEventPdf } from "./post-event-pdf";
import { getStorageProvider, type StorageProvider } from "../storage";
import type { NetworkingNotificationContext } from "./notification-rendering";

export async function processNetworkingPostEventReport(
  row: NetworkingDeliveryRow,
  ctx: NetworkingNotificationContext,
  storage?: StorageProvider,
) {
  if (
    !ctx.event ||
    !ctx.config.enabled ||
    !ctx.client?.active ||
    ctx.event.endDate >= new Date()
  ) {
    await updateNetworkingDelivery(row, {
      status: "SKIPPED",
      lockedUntil: null,
      payload: { outcome: "report_scope_unavailable" },
    });
    return "skipped" as const;
  }
  const data = await networkingPostEventReportData(
    row.eventId,
    ctx.config.timezone,
  );
  const { summary } = data;
  const pdf = await generateNetworkingPostEventPdf(
    ctx.event.name,
    data,
    ctx.config.defaultLanguage,
    ctx.config.primaryColor,
  );
  if (!(await refreshNetworkingDeliveryLease(row)))
    return "lease_lost" as const;
  const storageKey = `networking/reports/${row.eventId}/${row.id}.pdf`;
  await (storage ?? getStorageProvider()).uploadPrivate(
    pdf,
    storageKey,
    "application/pdf",
    {
      contentDisposition: 'attachment; filename="networking-report.pdf"',
      cacheControl: "private, no-store",
    },
  );
  return (await saveNetworkingPostEventReport(row, storageKey, summary))
    ? ("sent" as const)
    : ("lease_lost" as const);
}

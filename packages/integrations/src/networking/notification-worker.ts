import { sendNotification } from "web-push";
import {
  claimNetworkingDeliveries,
  networkingParticipantExportContacts,
  deleteNetworkingPushSubscription,
  networkingDeliveryContext,
  networkingDigestNotifications,
  localizeNetworkingNotification,
  updateNetworkingDelivery,
  refreshNetworkingDeliveryLease,
  beginNetworkingEmailLog,
  finishNetworkingEmailLog,
  type NetworkingDeliveryRow,
} from "@app/db";
import { getEmailProvider, getNetworkingEmailSender, type EmailProvider } from "../email/providers";
import type { StorageProvider } from "../storage";
import { renderNetworkingNotification } from "./notification-rendering";
import { networkingContactAttachment } from "./contact-export";
import { networkingDeliverySkipReason } from "./delivery-policy";
import { processNetworkingPostEventReport } from "./post-event-report";

/** Push endpoints are browser-provider endpoints, never participant-selected application URLs. */
export function allowedNetworkingPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    return [
      "fcm.googleapis.com",
      "push.services.mozilla.com",
      "push.apple.com",
      "notify.windows.com",
    ].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}
interface DeliveryProgress {
  emailSent?: boolean;
  pushEndpoints?: string[];
}
export interface NetworkingDeliveryDependencies {
  email?: EmailProvider;
  push?: typeof sendNotification;
  storage?: StorageProvider;
  eventId?: string;
  batchSize?: number;
}

async function processOne(
  row: NetworkingDeliveryRow,
  dependencies: NetworkingDeliveryDependencies,
) {
  if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
  let context = await networkingDeliveryContext(row);
  if (row.type === "POST_EVENT_REPORT")
    return processNetworkingPostEventReport(row, context, dependencies.storage);
  const skip = async (reason: string) => {
    await finishNetworkingEmailLog(row, "skipped");
    await updateNetworkingDelivery(row, {
      status: "SKIPPED",
      lockedUntil: null,
      payload: { ...(row.type === "OTP" ? {} : row.payload), outcome: reason },
      lastError: null,
    });
    return "skipped" as const;
  };
  const reason = networkingDeliverySkipReason(row, context);
  if (reason) return skip(reason);
  if (row.type === "POST_EVENT_CONTACTS") row.payload.contactCount = (await networkingParticipantExportContacts(row.eventId, row.profileId!)).length;
  if (row.type === "DAILY_DIGEST") {
    const summaries: string[] = [];
    for (const notification of await networkingDigestNotifications(row)) {
      const candidate = {
        ...row,
        type: notification.type,
        payload: {
          ...notification.data,
          notificationId: notification.id,
          href: notification.href,
        },
      };
      if (candidate.type === "POST_EVENT_CONTACTS") {
        row.payload.includeContacts = true;
        (candidate.payload as Record<string, unknown>).contactCount = (await networkingParticipantExportContacts(row.eventId, row.profileId!)).length;
      }
      const current = await networkingDeliveryContext(candidate);
      if (!networkingDeliverySkipReason(candidate, current))
        summaries.push(
          renderNetworkingNotification(
            candidate.type,
            candidate.payload,
            current,
          ).body,
        );
    }
    if (!summaries.length) return skip("digest_no_unread_updates");
    row.payload.digestSummaries = summaries;
  }
  let rendered = renderNetworkingNotification(row.type, row.payload, context);
  await localizeNetworkingNotification(
    row,
    rendered.title,
    rendered.body,
    rendered.relativeHref,
  );
  const progress: DeliveryProgress = {
    ...(row.payload._deliveryProgress as DeliveryProgress | undefined),
  };
  const payload: Record<string, unknown> = { ...row.payload, _deliveryProgress: progress };
  const failures: string[] = [];
  const sendEmail =
    row.type === "OTP" ||
    (row.type === "DAILY_DIGEST"
      ? context.profile!.emailPreference === "DAILY"
      : context.profile!.emailPreference === "IMMEDIATE");
  if (sendEmail && !progress.emailSent) {
    if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
    context = await networkingDeliveryContext(row);
    const changed = networkingDeliverySkipReason(row, context);
    if (changed) return skip(changed);
    const contacts = row.type === "POST_EVENT_CONTACTS" || row.payload.includeContacts === true ? await networkingParticipantExportContacts(row.eventId, row.profileId!) : undefined;
    if (contacts) { row.payload.contactCount = contacts.length; payload.contactCount = contacts.length; }
    rendered = renderNetworkingNotification(row.type, row.payload, context);
    const stillWantsEmail =
      row.type === "OTP" ||
      (row.type === "DAILY_DIGEST"
        ? context.profile!.emailPreference === "DAILY"
        : context.profile!.emailPreference === "IMMEDIATE");
    if (stillWantsEmail)
      try {
        const tracking = await beginNetworkingEmailLog(row, {
          registrationId: context.registration!.id,
          recipientEmail: context.profile!.email,
          recipientName: context.profile!.firstName,
          subject: rendered.subject,
        });
        if (tracking.leaseLost) return "lease_lost";
        if (!tracking.alreadySent) {
          const provider = dependencies.email ?? getEmailProvider();
          if (!provider.isConfigured())
            throw new Error("Email provider is not configured");
          const sender = getNetworkingEmailSender(context.event!.clientId, provider.name);
          if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
          const result = await provider.sendEmail({
            to: context.profile!.email,
            toName: context.profile!.firstName,
            fromName: sender?.name ?? context.event!.name,
            ...(sender ? { fromEmail: sender.email, senderClientId: context.event!.clientId } : {}),
            replyTo: context.config.supportEmail ?? undefined,
            subject: rendered.subject,
            html: rendered.html,
            plainText: rendered.plainText,
            attachments: [...rendered.attachments, ...(contacts ? [networkingContactAttachment(contacts, context.profile!.language)] : [])],
            trackingId: row.id,
            categories: ["networking", row.type],
          });
          if (!result.success)
            throw new Error("Email provider rejected delivery");
          await finishNetworkingEmailLog(row, "sent", result.messageId);
        }
        progress.emailSent = true;
        if (!(await updateNetworkingDelivery(row, { payload })))
          return "lease_lost";
      } catch {
        failures.push("email");
        await finishNetworkingEmailLog(row, "failed");
      }
  }
  if (row.type !== "OTP" && row.type !== "DAILY_DIGEST") {
    const delivered = new Set(progress.pushEndpoints ?? []);
    const push = dependencies.push ?? sendNotification;
    for (const subscription of context.subscriptions) {
      if (delivered.has(subscription.endpoint)) continue;
      if (
        !allowedNetworkingPushEndpoint(subscription.endpoint) ||
        (subscription.expirationTime &&
          subscription.expirationTime <= new Date())
      ) {
        await deleteNetworkingPushSubscription(subscription.id);
        continue;
      }
      if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
      const current = await networkingDeliveryContext(row);
      const changed = networkingDeliverySkipReason(row, current);
      if (changed) return skip(changed);
      if (!current.subscriptions.some((item) => item.id === subscription.id))
        continue;
      rendered = renderNetworkingNotification(row.type, row.payload, current);
      try {
        const publicKey = process.env.NETWORKING_VAPID_PUBLIC_KEY,
          privateKey = process.env.NETWORKING_VAPID_PRIVATE_KEY,
          subject = process.env.NETWORKING_VAPID_SUBJECT;
        if (!publicKey || !privateKey || !subject)
          throw new Error("Push provider is not configured");
        if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
        await push(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify({
            title: rendered.title,
            body: rendered.body.slice(0, 240),
            href: rendered.href || rendered.relativeHref,
            tag:
              row.type === "MESSAGE"
                ? String(row.payload.connectionId ?? row.id)
                : row.id,
            id: row.payload.notificationId ?? row.id,
          }),
          {
            vapidDetails: { publicKey, privateKey, subject },
            TTL: 3600,
            timeout: 10_000,
          },
        );
        delivered.add(subscription.endpoint);
      } catch (error) {
        if (
          [404, 410].includes(
            Number((error as { statusCode?: number }).statusCode),
          )
        ) {
          await deleteNetworkingPushSubscription(subscription.id);
          delivered.add(subscription.endpoint);
        } else failures.push(`push:${subscription.id}`);
      }
      progress.pushEndpoints = [...delivered];
      if (!(await updateNetworkingDelivery(row, { payload })))
        return "lease_lost";
    }
  }
  if (failures.length) {
    const exhausted = row.attempts >= 5;
    await updateNetworkingDelivery(row, {
      status: "FAILED",
      lockedUntil: null,
      payload:
        row.type === "OTP" && exhausted
          ? { challengeId: row.payload.challengeId, outcome: "retry_exhausted" }
          : payload,
      lastError: `Notification channels failed: ${failures.map((channel) => channel.split(":")[0]).join(", ")}`,
      availableAt: new Date(
        Date.now() + Math.min(15, 2 ** row.attempts) * 60_000,
      ),
    });
    return "failed";
  }
  await updateNetworkingDelivery(row, {
    status: "SENT",
    lockedUntil: null,
    lastError: null,
    payload:
      row.type === "OTP"
        ? { challengeId: row.payload.challengeId, outcome: "sent" }
        : payload,
  });
  return "sent";
}
export async function processNetworkingDeliveries(
  dependencies: NetworkingDeliveryDependencies = {},
) {
  const rows = await claimNetworkingDeliveries(
    dependencies.batchSize ?? 4,
    dependencies.eventId,
  );
  const result = { sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      const outcome = await processOne(row, dependencies);
      if (outcome === "sent") result.sent++;
      else if (outcome === "skipped") result.skipped++;
      else if (outcome === "failed") result.failed++;
    } catch {
      await updateNetworkingDelivery(row, {
        status: "FAILED",
        lockedUntil: null,
        ...(row.type === "OTP" && row.attempts >= 5
          ? {
              payload: {
                challengeId: row.payload.challengeId,
                outcome: "retry_exhausted",
              },
            }
          : {}),
        lastError: "Notification delivery failed",
        availableAt: new Date(
          Date.now() + Math.min(15, 2 ** row.attempts) * 60_000,
        ),
      });
      result.failed++;
    }
  }
  return result;
}

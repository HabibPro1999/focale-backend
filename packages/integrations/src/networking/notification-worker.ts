import { sendNotification } from "web-push";
import {
  claimNetworkingDeliveries,
  networkingParticipantExportContacts,
  deleteNetworkingPushSubscription,
  networkingDeliveryContext,
  networkingDigestContexts,
  localizeNetworkingNotification,
  updateNetworkingDelivery,
  refreshNetworkingDeliveryLease,
  beginNetworkingEmailLog,
  markNetworkingEmailAttempt,
  finishNetworkingEmailLog,
  NETWORKING_DELIVERY_MAX_ATTEMPTS,
  type NetworkingDeliveryRow,
} from "@app/db";
import { integrationsConfigFromEnv } from "@app/contracts";
import {
  ambiguousSend,
  getEmailProvider,
  getNetworkingEmailSender,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailOutcome,
  type SendEmailResult,
} from "../email/providers";
import type { StorageProvider } from "../storage";
import {
  renderNetworkingNotification,
  type NetworkingNotificationContext,
} from "./notification-rendering";
import { networkingConfig } from "../config";
import { runClaimLanes } from "./lanes";
import {
  networkingEmailRateLimiter,
  type NetworkingEmailRateLimiter,
} from "./email-rate-limiter";
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
  /** The provider may have sent the email; it is never sent again automatically. */
  emailUncertain?: boolean;
  pushEndpoints?: string[];
}

/** Delivery worker throughput (4.2), validated by the config schema. */
export interface NetworkingDeliveryWorkerOptions {
  /** Rows a general lane claims at a time (processed one after another). */
  batchSize: number;
  /** General lanes (every delivery type but OTP). */
  concurrency: number;
  /** Lanes that claim only sign-in codes, one at a time. */
  otpLanes: number;
  /** Networking emails per second per worker process (token bucket). */
  emailRatePerSecond: number;
  /** The worker job's interval. */
  intervalMs: number;
  /** Lanes stop claiming this long after a run starts (claimed rows are finished). */
  runBudgetMs: number;
}
export const NETWORKING_DELIVERY_INTERVAL_MS = 1_000;
const NETWORKING_DELIVERY_RUN_BUDGET_MS = 15_000;
/** A dedicated OTP lane polls this often while the other lanes are still working. */
const OTP_IDLE_POLL_MS = 250;

/** The configured slice, or `source` parsed with the same rules when given. */
export function networkingDeliveryWorkerOptions(source?: NodeJS.ProcessEnv): NetworkingDeliveryWorkerOptions {
  const { batchSize, concurrency, otpLanes, emailRatePerSecond } = (
    source ? integrationsConfigFromEnv(source).networking : networkingConfig()
  ).delivery;
  return {
    batchSize,
    concurrency,
    otpLanes,
    emailRatePerSecond,
    intervalMs: NETWORKING_DELIVERY_INTERVAL_MS,
    runBudgetMs: NETWORKING_DELIVERY_RUN_BUDGET_MS,
  };
}

export interface NetworkingDeliveryDependencies {
  email?: EmailProvider;
  push?: typeof sendNotification;
  storage?: StorageProvider;
  eventId?: string;
  /** Claim size of the general lanes (default: the configured batch size). */
  batchSize?: number;
  /** Overrides of the configured worker options. */
  options?: Partial<NetworkingDeliveryWorkerOptions>;
  /** Default: the process-wide bucket at the configured rate. */
  emailLimiter?: NetworkingEmailRateLimiter;
  /** Epoch ms after which no lane claims again (default: now + runBudgetMs). */
  until?: number;
  /** Stops claiming (shutdown or job timeout); an email waiting for a token is abandoned. */
  signal?: AbortSignal;
}

type Outcome = "sent" | "skipped" | "failed" | "uncertain" | "deferred" | "lease_lost";

type EmailChannel =
  | { status: "sent" | "uncertain" | "failed" | "lease_lost" }
  | { status: "deferred"; until: Date };

const UNCERTAIN_EMAIL_ERROR = "Email provider outcome unknown; not resent automatically";

/** A provider call that never throws: an unexpected throw is an ambiguous outcome (3.6). */
async function callProvider(provider: EmailProvider, input: SendEmailInput): Promise<SendEmailResult> {
  try {
    return await provider.sendEmail(input);
  } catch (error: unknown) {
    return ambiguousSend(error instanceof Error ? error.message : String(error));
  }
}

function sendOutcome(result: SendEmailResult): SendEmailOutcome {
  return result.outcome ?? (result.success ? "accepted" : "rejected");
}

/**
 * One email attempt, classified as 3.6 does for the generic queue:
 * - accepted: SENT, never sent again (a failed SENT write leaves the
 *   provider-attempt marker, so a later claim never resends blind);
 * - rejected: retried like any failure; a 429 pauses the bucket and defers
 *   the delivery without counting an attempt;
 * - ambiguous: retried under the same idempotency key when the provider
 *   deduplicates on it (Resend) and attempts remain, else UNCERTAIN: the
 *   email channel is settled and never sent again automatically.
 * Provider errors never reach the database; only generic messages do.
 */
async function sendEmailChannel(
  row: NetworkingDeliveryRow,
  context: NetworkingNotificationContext,
  rendered: ReturnType<typeof renderNetworkingNotification>,
  contacts: Awaited<ReturnType<typeof networkingParticipantExportContacts>> | undefined,
  dependencies: NetworkingDeliveryDependencies,
  limiter: NetworkingEmailRateLimiter,
): Promise<EmailChannel> {
  let started: Awaited<ReturnType<typeof beginNetworkingEmailLog>>;
  let provider: EmailProvider;
  let sender: ReturnType<typeof getNetworkingEmailSender>;
  try {
    started = await beginNetworkingEmailLog(row, {
      registrationId: context.registration!.id,
      recipientEmail: context.profile!.email,
      recipientName: context.profile!.firstName,
      subject: rendered.subject,
    });
    if (started.leaseLost) return { status: "lease_lost" };
    if (started.alreadySent) return { status: "sent" };
    if (started.uncertain) return { status: "uncertain" };
    provider = dependencies.email ?? getEmailProvider();
    if (!provider.isConfigured())
      throw new Error("Email provider is not configured");
    sender = getNetworkingEmailSender(context.event!.clientId, provider.name);
  } catch {
    // Nothing reached the provider in this claim.
    await finishNetworkingEmailLog(row, "failed");
    return { status: "failed" };
  }
  try {
    await limiter.take(row.type === "OTP" ? "otp" : "other", dependencies.signal);
  } catch {
    // Stopping (shutdown or job timeout) while waiting for a token: nothing
    // was sent, and the next run picks it up without a spent attempt.
    await finishNetworkingEmailLog(row, "deferred", "Networking email interrupted before sending; retried");
    return { status: "deferred", until: new Date() };
  }
  // The marker (and a lease renewal) right before the call: past this point
  // the email is never sent again blind.
  if (!(await markNetworkingEmailAttempt(row, provider.name))) return { status: "lease_lost" };
  const result = await callProvider(provider, {
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
  const outcome = sendOutcome(result);
  if (outcome === "accepted") {
    limiter.succeeded();
    try {
      await finishNetworkingEmailLog(row, "sent", result.messageId);
    } catch {
      /* Accepted by the provider: the persisted progress (or the marker) keeps later claims from resending. */
    }
    return { status: "sent" };
  }
  // Only bookkeeping below: when it fails, the claim is abandoned to lease
  // expiry and the marker settles the email on the next claim.
  try {
    if (outcome === "rejected" && result.statusCode === 429) {
      const until = new Date(limiter.rateLimited());
      await finishNetworkingEmailLog(row, "deferred");
      return { status: "deferred", until };
    }
    if (outcome === "rejected") {
      await finishNetworkingEmailLog(row, "failed");
      return { status: "failed" };
    }
    if (result.idempotentRetry && row.attempts < NETWORKING_DELIVERY_MAX_ATTEMPTS) {
      await finishNetworkingEmailLog(row, "failed", "Email provider outcome unknown; retrying under the same idempotency key");
      return { status: "failed" };
    }
    await finishNetworkingEmailLog(row, "uncertain", UNCERTAIN_EMAIL_ERROR);
    return { status: "uncertain" };
  } catch {
    return { status: "lease_lost" };
  }
}

async function processOne(
  row: NetworkingDeliveryRow,
  dependencies: NetworkingDeliveryDependencies,
  limiter: NetworkingEmailRateLimiter,
): Promise<Outcome> {
  if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
  const pushable = row.type !== "OTP" && row.type !== "DAILY_DIGEST" && row.type !== "POST_EVENT_REPORT";
  let context = await networkingDeliveryContext(row, { subscriptions: pushable });
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
    // Every unread notice with the records it names, in one statement.
    for (const { notification, context: current } of await networkingDigestContexts(row, context)) {
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
  let deferUntil: Date | undefined;
  const wantsEmail = (current: NetworkingNotificationContext) =>
    row.type === "OTP" ||
    (row.type === "DAILY_DIGEST"
      ? current.profile!.emailPreference === "DAILY"
      : current.profile!.emailPreference === "IMMEDIATE");
  if (wantsEmail(context) && !progress.emailSent && !progress.emailUncertain) {
    // The email channel's one revalidation (the push channel re-reads its
    // subscriptions itself; the claim's list still decides whether it runs).
    if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
    context = {
      ...(await networkingDeliveryContext(row, { subscriptions: false })),
      subscriptions: context.subscriptions,
    };
    const changed = networkingDeliverySkipReason(row, context);
    if (changed) return skip(changed);
    const contacts = row.type === "POST_EVENT_CONTACTS" || row.payload.includeContacts === true ? await networkingParticipantExportContacts(row.eventId, row.profileId!) : undefined;
    if (contacts) { row.payload.contactCount = contacts.length; payload.contactCount = contacts.length; }
    rendered = renderNetworkingNotification(row.type, row.payload, context);
    if (wantsEmail(context)) {
      const email = await sendEmailChannel(row, context, rendered, contacts, dependencies, limiter);
      if (email.status === "lease_lost") return "lease_lost";
      if (email.status === "sent") progress.emailSent = true;
      else if (email.status === "uncertain") progress.emailUncertain = true;
      else if (email.status === "failed") failures.push("email");
      else if (email.status === "deferred") deferUntil = email.until;
      if (progress.emailSent || progress.emailUncertain) {
        try {
          if (!(await updateNetworkingDelivery(row, { payload }))) return "lease_lost";
        } catch {
          return "lease_lost";
        }
      }
    }
  }
  if (pushable) {
    const delivered = new Set(progress.pushEndpoints ?? []);
    if (context.subscriptions.some((subscription) => !delivered.has(subscription.endpoint))) {
      // The push channel's one revalidation, for all of its endpoints.
      if (!(await refreshNetworkingDeliveryLease(row))) return "lease_lost";
      const current = await networkingDeliveryContext(row);
      const changed = networkingDeliverySkipReason(row, current);
      if (changed) return skip(changed);
      rendered = renderNetworkingNotification(row.type, row.payload, current);
      const push = dependencies.push ?? sendNotification;
      for (const subscription of current.subscriptions) {
        if (delivered.has(subscription.endpoint)) continue;
        if (
          !allowedNetworkingPushEndpoint(subscription.endpoint) ||
          (subscription.expirationTime &&
            subscription.expirationTime <= new Date())
        ) {
          await deleteNetworkingPushSubscription(subscription.id);
          continue;
        }
        try {
          const { publicKey, privateKey, subject } = networkingConfig().vapid;
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
  }
  if (!failures.length && deferUntil) {
    // Only the provider's rate limit stood in the way: not a failed attempt.
    await updateNetworkingDelivery(row, {
      status: "FAILED",
      lockedUntil: null,
      attempts: Math.max(0, row.attempts - 1),
      payload,
      lastError: "Email deferred (provider rate limit or worker stopping); retried without spending an attempt",
      availableAt: deferUntil,
    });
    return "deferred";
  }
  if (failures.length) {
    const exhausted = row.attempts >= NETWORKING_DELIVERY_MAX_ATTEMPTS;
    const backoff = new Date(Date.now() + Math.min(15, 2 ** row.attempts) * 60_000);
    await updateNetworkingDelivery(row, {
      status: "FAILED",
      lockedUntil: null,
      payload:
        row.type === "OTP" && exhausted
          ? { challengeId: row.payload.challengeId, outcome: "retry_exhausted" }
          : payload,
      lastError: `Notification channels failed: ${failures.map((channel) => channel.split(":")[0]).join(", ")}`,
      availableAt: deferUntil && deferUntil > backoff ? deferUntil : backoff,
    });
    return "failed";
  }
  await updateNetworkingDelivery(row, {
    status: "SENT",
    lockedUntil: null,
    lastError: progress.emailUncertain ? UNCERTAIN_EMAIL_ERROR : null,
    payload:
      row.type === "OTP"
        ? { challengeId: row.payload.challengeId, outcome: progress.emailUncertain ? "email_uncertain" : "sent" }
        : payload,
  });
  return progress.emailUncertain ? "uncertain" : "sent";
}

export interface NetworkingDeliveryResult {
  sent: number;
  skipped: number;
  failed: number;
  /** Settled without a known email outcome (the email log is UNCERTAIN). */
  uncertain: number;
  /** Put back by the provider's rate limit. */
  deferred: number;
}

/**
 * The delivery lanes (4.2), on the networking lane loop: `concurrency`
 * general lanes claim `batchSize` rows at a time (every type but OTP), and
 * `otpLanes` dedicated lanes claim sign-in codes one at a time, polling while
 * the general lanes work, so a code never waits behind digests. Lanes stop
 * claiming at `until` and finish what they claimed; on `signal` they also
 * hand back the rows they have not started. Every email goes through the
 * worker's token bucket.
 */
export async function processNetworkingDeliveries(
  dependencies: NetworkingDeliveryDependencies = {},
): Promise<NetworkingDeliveryResult> {
  const options = { ...networkingDeliveryWorkerOptions(), ...dependencies.options };
  const batchSize = dependencies.batchSize ?? options.batchSize;
  const limiter = dependencies.emailLimiter ?? networkingEmailRateLimiter(options.emailRatePerSecond);
  const result: NetworkingDeliveryResult = { sent: 0, skipped: 0, failed: 0, uncertain: 0, deferred: 0 };
  const processRows = async (rows: NetworkingDeliveryRow[]) => {
    for (const [index, row] of rows.entries()) {
      if (dependencies.signal?.aborted) {
        // Stopping: hand back what this lane claimed but did not start.
        for (const unstarted of rows.slice(index))
          await updateNetworkingDelivery(unstarted, {
            status: "PENDING",
            lockedUntil: null,
            attempts: Math.max(0, unstarted.attempts - 1),
          }).catch(() => false);
        return;
      }
      try {
        const outcome = await processOne(row, dependencies, limiter);
        if (outcome !== "lease_lost") result[outcome]++;
      } catch {
        await updateNetworkingDelivery(row, {
          status: "FAILED",
          lockedUntil: null,
          ...(row.type === "OTP" && row.attempts >= NETWORKING_DELIVERY_MAX_ATTEMPTS
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
        }).catch(() => false);
        result.failed++;
      }
    }
  };
  await runClaimLanes(
    [
      {
        lanes: options.concurrency,
        claim: () => claimNetworkingDeliveries(batchSize, dependencies.eventId, "other"),
        process: processRows,
      },
      {
        lanes: options.otpLanes,
        claim: () => claimNetworkingDeliveries(1, dependencies.eventId, "otp"),
        process: processRows,
        idlePollMs: OTP_IDLE_POLL_MS,
      },
    ],
    { until: dependencies.until ?? Date.now() + options.runBudgetMs, signal: dependencies.signal },
  );
  return result;
}

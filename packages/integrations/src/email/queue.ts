// =============================================================================
// EMAIL QUEUE CORE
// Orchestrates the database-backed email queue: automatic-send entry points
// (queueTriggeredEmail / queueSponsorshipEmail), the worker drain loop
// (processEmailQueue), and the webhook status state-machine
// (updateEmailStatusFromWebhook).
//
// Concurrency safety is LEASE-based, not transaction-based: rows are claimed
// through the email lease queue (runLeased: FOR UPDATE SKIP LOCKED, one
// heartbeat renewing every claimed row) and every subsequent write re-checks
// lockedBy ownership (the @app/db primitives return false — not throw — when
// the lease was lost, which we map to a non-counted "lease-lost" outcome).
// This is deliberately NOT withTxnRetry/serializable; the semantics are lease
// expiry + ownership, not conflict retry.
//
// Delivery safety (3.6): the provider-attempt marker is written right before
// the provider call, and every call is classified accepted / rejected /
// ambiguous. Only a rejection (or an error before the call) is retried; an
// accepted email is never requeued, and an ambiguous one becomes UNCERTAIN
// unless the provider deduplicates on the log id (Resend's idempotency key).
// =============================================================================

import { createLogger, makeWorkerId, escapeHtml } from "@app/shared";
import type { AppEvent, AutomaticEmailTrigger, EmailStatus } from "@app/contracts";
import {
  getTemplateByTrigger,
  createEmailLog,
  hasActiveEmailLogForRegistrationTrigger,
  hasActiveSponsorshipEmailLog,
  emailQueue,
  getClaimedEmailLogsForProcessing,
  runLeased,
  writeResolvedSubjectIfLeaseHeld,
  beginProviderAttempt,
  markEmailSent,
  markEmailFailed,
  markEmailSkipped,
  markEmailUncertain,
  readEmailLogStatus,
  updateEmailLogStatusGuarded,
  getEmailLogRealtimeTarget,
  enqueueRealtimeOutboxEvent,
  getDb,
  pgUniqueViolation,
  resendUncertainEmailLog,
  type ClaimedEmailLog,
  type ResendEmailLogResult,
  type EmailLogRow,
  type EmailLogInsert,
} from "@app/db";
import { getEmailProvider } from "./providers/index";
import {
  ambiguousSend,
  type EmailAttachment,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
} from "./providers/email-provider.types";
import { resolveVariables, buildEmailContextWithAccess } from "./rendering/index";

const logger = createLogger({ name: "email:queue" });

const MAX_RETRIES = 3;
const DEFAULT_WORKER_ID = makeWorkerId("email");
/** Tries of an outcome write after the provider call (never a resend). */
const OUTCOME_WRITE_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// Realtime seam. In the legacy monolith the queue emitted emailLog.statusChanged
// on the in-process EventBus. In the split architecture realtime fan-out goes
// through the outbox / EventBus in the api process, which this framework-free
// package cannot reach. The worker/api bootstrap wires a listener here (N3):
// see `emitEmailLogRealtimeEvent` below, installed via setEmailStatusChangeListener
// at process startup in both apps/worker/src/main.ts and apps/api/src/main.ts —
// emails can be queued/updated from either process.
// -----------------------------------------------------------------------------
export type EmailStatusChangeListener = (
  emailLogId: string,
  status: string,
) => void | Promise<void>;

let statusChangeListener: EmailStatusChangeListener | undefined;

export function setEmailStatusChangeListener(
  fn: EmailStatusChangeListener | undefined,
): void {
  statusChangeListener = fn;
}

/**
 * Tell the installed listener that an email log changed status (the queue,
 * sendEmailNow, webhooks). Fire-and-forget: never blocks the caller, never
 * throws. Handles both a synchronous throw and an async rejection from the
 * listener.
 */
export function notifyStatusChange(emailLogId: string, status: string): void {
  if (!statusChangeListener) return;
  try {
    void Promise.resolve(statusChangeListener(emailLogId, status)).catch(
      (err: unknown) => {
        logger.warn(
          { err, emailLogId },
          "Failed to notify emailLog status change",
        );
      },
    );
  } catch (err) {
    logger.warn({ err, emailLogId }, "Failed to notify emailLog status change");
  }
}

/**
 * Default realtime listener body (N3): resolve the (clientId, eventId,
 * registrationId) an EmailLog belongs to — via its registration when
 * registrationId is set, via its abstract → event when abstractId is set —
 * and enqueue a `realtime.emit` outbox event carrying `emailLog.statusChanged`.
 * Installed as the process's EmailStatusChangeListener at startup. A log with
 * neither relation (or one that's since vanished) resolves to null and is a
 * silent no-op — nothing to fan out to.
 */
export async function emitEmailLogRealtimeEvent(
  emailLogId: string,
  status: string,
): Promise<void> {
  const target = await getEmailLogRealtimeTarget(emailLogId);
  if (!target) return;

  const event: AppEvent = {
    type: "emailLog.statusChanged",
    clientId: target.clientId,
    eventId: target.eventId,
    payload: {
      id: emailLogId,
      status,
      registrationId: target.registrationId ?? undefined,
    },
    ts: Date.now(),
  };
  await enqueueRealtimeOutboxEvent(getDb(), event);
}

// -----------------------------------------------------------------------------
// Context helpers
// -----------------------------------------------------------------------------

type QueueEmailContext = Record<string, unknown>;

function isUsableContextSnapshot(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return false;
  return Object.keys(obj).length > 0;
}

function getOptionalContextString(
  context: QueueEmailContext,
  key: string,
): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// -----------------------------------------------------------------------------
// Fallback template (C1/N4): when queueAbstractEmail found no admin template it
// stashes an unresolved {{var}} subject/body pair directly in contextSnapshot
// instead of a real EmailTemplate row. Detected here so the send path treats it
// exactly like a template — resolved via the same resolveVariables call — and
// ACTUALLY SENDS, rather than hitting the "no template" skip.
// -----------------------------------------------------------------------------
// The admin resend (@app/db email-resend.ts) checks the same keys.
export const FALLBACK_SUBJECT_KEY = "_fallbackSubject";
export const FALLBACK_BODY_KEY = "_fallbackPlainBody";

interface FallbackTemplate {
  subject: string;
  body: string;
}

function getFallbackTemplate(contextSnapshot: unknown): FallbackTemplate | null {
  if (!isUsableContextSnapshot(contextSnapshot)) return null;
  const subject = contextSnapshot[FALLBACK_SUBJECT_KEY];
  const body = contextSnapshot[FALLBACK_BODY_KEY];
  if (typeof subject !== "string" || typeof body !== "string") return null;
  return { subject, body };
}

/** Minimal plain-text → HTML: escape, then preserve newlines via CSS. */
function plainTextToHtml(text: string): string {
  return `<div style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text)}</div>`;
}

// =============================================================================
// QUEUE EMAIL (low-level primitive)
// =============================================================================

export interface QueueEmailInput {
  trigger?: AutomaticEmailTrigger;
  registrationId?: string;
  recipientEmail: string;
  recipientName?: string;
  abstractId?: string;
  abstractTrigger?: EmailLogInsert["abstractTrigger"];
  /** Optional (C1/N4): a fallback-only send (no admin template) has none. */
  templateId?: string;
  contextSnapshot?: Record<string, unknown>;
  /** H6: per-outbox-delivery idempotency key (see EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY). */
  dedupeKey?: string;
}

/**
 * Create a QUEUED EmailLog (subject resolved later at processing time). The
 * partial-unique dedupe indexes are the race backstop: createEmailLog returns
 * `{ok:false, conflictIndex}` (rather than throwing) when a concurrent insert
 * won, which the automatic-send callers treat as an idempotent skip.
 */
export async function queueEmail(
  input: QueueEmailInput,
): Promise<
  { ok: true; log: EmailLogRow } | { ok: false; conflictIndex: string }
> {
  const result = await createEmailLog({
    trigger: input.trigger ?? null,
    templateId: input.templateId ?? null,
    registrationId: input.registrationId ?? null,
    abstractId: input.abstractId ?? null,
    abstractTrigger: input.abstractTrigger ?? null,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName ?? null,
    subject: "",
    status: "QUEUED",
    contextSnapshot: input.contextSnapshot ?? null,
    dedupeKey: input.dedupeKey ?? null,
  });
  if (result.ok) notifyStatusChange(result.log.id, "QUEUED");
  return result;
}

// =============================================================================
// QUEUE TRIGGERED EMAIL (automatic sends, e.g. REGISTRATION_CREATED)
// =============================================================================

/**
 * Queue an email for an event+trigger. Returns false (no error) when no active
 * template is configured, when an active email already exists for this
 * registration+trigger, or when the DB dedupe index wins a concurrent race.
 */
export async function queueTriggeredEmail(
  trigger: AutomaticEmailTrigger,
  eventId: string,
  registration: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<boolean> {
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  if (await hasActiveEmailLogForRegistrationTrigger(registration.id, trigger)) {
    logger.info(
      { registrationId: registration.id, trigger },
      "Triggered email already queued, skipping duplicate",
    );
    return false;
  }

  const result = await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: registration.id,
    recipientEmail: registration.email,
    recipientName:
      [registration.firstName, registration.lastName]
        .filter(Boolean)
        .join(" ") || undefined,
  });

  if (!result.ok) {
    logger.info(
      { registrationId: registration.id, trigger },
      "Triggered email already queued, skipping duplicate",
    );
    return false;
  }

  logger.info(
    { trigger, eventId, registrationId: registration.id },
    "Queued triggered email",
  );
  return true;
}

// =============================================================================
// QUEUE SPONSORSHIP EMAIL (automatic sends with a custom context snapshot)
// =============================================================================

export interface QueueSponsorshipEmailInput {
  recipientEmail: string;
  recipientName?: string;
  context: Record<string, unknown>;
  registrationId?: string;
}

/**
 * Queue a sponsorship email (SPONSORSHIP_BATCH_SUBMITTED / _LINKED / _APPLIED).
 * Dedup key is trigger+templateId+recipientEmail (+registrationId when set).
 * Same false-on-skip / false-on-race semantics as queueTriggeredEmail.
 */
export async function queueSponsorshipEmail(
  trigger: AutomaticEmailTrigger,
  eventId: string,
  input: QueueSponsorshipEmailInput,
): Promise<boolean> {
  const template = await getTemplateByTrigger(eventId, trigger);
  if (!template) {
    logger.warn(
      { trigger, eventId },
      "No email template configured for trigger - email not sent",
    );
    return false;
  }

  if (
    await hasActiveSponsorshipEmailLog({
      trigger,
      templateId: template.id,
      recipientEmail: input.recipientEmail,
      registrationId: input.registrationId,
    })
  ) {
    logger.info(
      { trigger, eventId, recipientEmail: input.recipientEmail },
      "Sponsorship email already queued, skipping duplicate",
    );
    return false;
  }

  const result = await queueEmail({
    trigger,
    templateId: template.id,
    registrationId: input.registrationId,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName,
    contextSnapshot: input.context,
  });

  if (!result.ok) {
    logger.info(
      { trigger, eventId, recipientEmail: input.recipientEmail },
      "Sponsorship email already queued, skipping duplicate",
    );
    return false;
  }

  logger.info(
    { trigger, eventId, recipientEmail: input.recipientEmail },
    "Queued sponsorship email",
  );
  return true;
}

// =============================================================================
// CERTIFICATE ATTACHMENT HOOK (wave-3 seam)
//
// The certificate module (wave 3) owns re-fetching the registration, validating
// that the queued certificate templates are still active/in-scope, and
// rendering the PDFs. It lands as an injected generator so this package stays
// free of a certificates dependency and remains testable with a stub. The
// generator throwing (e.g. "templates no longer active") propagates to
// processEmail's catch → markEmailFailed (retryable).
//
// H2: abstract-linked CERTIFICATE_SENT rows carry abstractId instead of
// registrationId (deliberately — an abstract's optional registrationId link
// would render the wrong registration's data). Exactly one of the two is set;
// the generator branches on whichever is present.
// =============================================================================

export interface CertificateAttachmentContext {
  registrationId?: string;
  abstractId?: string;
  /** From contextSnapshot._certificateTemplateIds — the templates queued. */
  certificateTemplateIds: string[];
}

export type CertificateAttachmentGenerator = (
  ctx: CertificateAttachmentContext,
) => Promise<EmailAttachment[]>;

// =============================================================================
// PROCESS QUEUE (worker loop)
// =============================================================================

export interface ProcessQueueResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Parked as UNCERTAIN: the provider may have sent them; not resent automatically. */
  uncertain: number;
}

export interface ProcessEmailQueueOptions {
  workerId?: string;
  leaseMs?: number;
  /** Injected by the worker (wave 3). Required to process CERTIFICATE_SENT rows. */
  generateCertificateAttachments?: CertificateAttachmentGenerator;
  /**
   * Job signal (timeout or shutdown): no new row starts, and claimed rows not
   * started go back to the queue without an attempt charged. A send already
   * handed to the provider is never interrupted.
   */
  signal?: AbortSignal;
  /**
   * Keep claiming batches until one comes back short, the signal aborts, or
   * this time (epoch ms) passes. Without it, one batch.
   */
  drainUntil?: number;
}

/**
 * - `unsettled`: the provider was called but the outcome could not be
 *   written. The row keeps its provider-attempt marker and lease recovery
 *   settles it (UNCERTAIN, or a same-key retry for Resend): never a blind resend.
 */
type EmailOutcome = "sent" | "failed" | "skipped" | "uncertain" | "lease-lost" | "unsettled";

export async function processEmailQueue(
  batchSize = 20,
  options: ProcessEmailQueueOptions = {},
): Promise<ProcessQueueResult> {
  const result: ProcessQueueResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
  };

  const workerId = options.workerId ?? DEFAULT_WORKER_ID;

  const CONCURRENCY_LIMIT = 10;
  /** Rows whose provider call started (this claim): never failed (requeued) by onError. */
  const providerCalled = new Set<string>();

  // N3/M8: SKIPPED is a status transition like SENT/FAILED — the admin's live
  // email-log table must hear about it too, not just the happy paths.
  async function skipEmail(
    emailLogId: string,
    reason: string,
  ): Promise<EmailOutcome> {
    const ok = await markEmailSkipped(emailLogId, workerId, reason);
    if (ok) notifyStatusChange(emailLogId, "SKIPPED");
    return ok ? "skipped" : "lease-lost";
  }

  // `signal` aborts on the job signal or when this row's lease is lost.
  async function processEmail(
    emailLog: ClaimedEmailLog,
    signal: AbortSignal,
  ): Promise<EmailOutcome> {
    // A drain can claim a requeued row again: this claim has not called the provider yet.
    providerCalled.delete(emailLog.id);
    try {
      let templateSubject: string;
      let templateHtml: string;
      let templatePlain: string;

      if (emailLog.template) {
        if (!emailLog.template.isActive) {
          return skipEmail(emailLog.id, "Template is inactive");
        }
        templateSubject = emailLog.template.subject;
        templateHtml = emailLog.template.htmlContent || "";
        templatePlain = emailLog.template.plainContent || "";
      } else {
        // C1/N4: a plain-text fallback body (built by queueAbstractEmail when
        // no admin template exists) rides in contextSnapshot as an unresolved
        // {{var}} template — same resolution path as a real template, so it
        // gets ACTUALLY SENT rather than marked SKIPPED (the bug this restores).
        const fallback = getFallbackTemplate(emailLog.contextSnapshot);
        if (!fallback) {
          return skipEmail(emailLog.id, "No template found");
        }
        templateSubject = fallback.subject;
        templatePlain = fallback.body;
        templateHtml = plainTextToHtml(fallback.body);
      }

      let context: QueueEmailContext | null = null;
      if (isUsableContextSnapshot(emailLog.contextSnapshot)) {
        context = emailLog.contextSnapshot;
      } else if (emailLog.registration) {
        context = (await buildEmailContextWithAccess(
          emailLog.registration,
        )) as unknown as QueueEmailContext;
      }

      if (!context || Object.keys(context).length === 0) {
        return skipEmail(emailLog.id, "Could not build email context");
      }

      const resolvedSubject = resolveVariables(templateSubject, context, { mode: "text" });
      const resolvedHtml = resolveVariables(templateHtml, context);
      const resolvedPlain = resolveVariables(templatePlain, context, { mode: "text" });

      // Persist the resolved subject only if the lease is still held.
      if (
        !(await writeResolvedSubjectIfLeaseHeld(
          emailLog.id,
          workerId,
          resolvedSubject,
        ))
      ) {
        logger.warn(
          { emailLogId: emailLog.id, workerId },
          "Email subject update skipped because lease was lost before send",
        );
        return "lease-lost";
      }

      // Certificate attachments (delegated to the wave-3 generator).
      let attachments: EmailAttachment[] | undefined;
      const certTemplateIds = context._certificateTemplateIds;
      if (
        emailLog.trigger === "CERTIFICATE_SENT" &&
        Array.isArray(certTemplateIds) &&
        certTemplateIds.length > 0 &&
        (emailLog.registrationId || emailLog.abstractId)
      ) {
        const templateIds = certTemplateIds as string[];
        const expectedCount = templateIds.length;

        if (!options.generateCertificateAttachments) {
          // TODO(wave-3): the worker must inject generateCertificateAttachments.
          throw new Error("Certificate attachment generator not configured");
        }

        attachments = await options.generateCertificateAttachments({
          registrationId: emailLog.registrationId ?? undefined,
          abstractId: emailLog.abstractId ?? undefined,
          certificateTemplateIds: templateIds,
        });

        if (!attachments || attachments.length === 0) {
          return skipEmail(emailLog.id, "No eligible certificates to attach");
        }
        if (attachments.length < expectedCount) {
          throw new Error("Fewer certificate attachments generated than queued");
        }
      }

      // The provider-attempt marker, written with an ownership re-check (and
      // lease extension) right before the network call: no double send after
      // a lease expiry + requeue by another worker. Past this point the send
      // is never interrupted, and the row is never requeued blind.
      signal.throwIfAborted();
      const provider = getEmailProvider();
      if (!(await beginProviderAttempt(emailLog.id, workerId, provider.name, options.leaseMs))) {
        logger.warn(
          { emailLogId: emailLog.id, workerId },
          "Email send skipped because lease was lost before provider call",
        );
        return "lease-lost";
      }
      providerCalled.add(emailLog.id);

      const sendResult = await callEmailProvider(provider, {
        to: emailLog.recipientEmail,
        toName: emailLog.recipientName || undefined,
        fromName:
          getOptionalContextString(context, "eventName") ??
          getOptionalContextString(context, "congressName"),
        replyTo: getOptionalContextString(context, "organizerEmail"),
        replyToName: getOptionalContextString(context, "organizerName"),
        subject: resolvedSubject,
        html: resolvedHtml,
        plainText: resolvedPlain,
        trackingId: emailLog.id,
        attachments,
      });
      return await settleProviderCall(emailLog, sendResult);
    } catch (error: unknown) {
      if (providerCalled.has(emailLog.id)) {
        // Only a failed outcome write gets here. Requeueing could send the
        // email twice: the marker stays and lease recovery settles the row.
        logger.error(
          { err: error, emailLogId: emailLog.id },
          "Recording an email send outcome failed; left for lease recovery",
        );
        return "unsettled";
      }
      // An abort (lost lease, timeout, shutdown) is runLeased's to settle.
      if (signal.aborted) throw error;
      const err = error as Error;
      logger.error(
        { emailLogId: emailLog.id, error: err.message },
        "Error processing email",
      );
      return failEmail(emailLog, err.message, workerId);
    }
  }

  /**
   * One provider outcome → the row's state (3.6):
   * - accepted: SENT, never requeued (the write is retried; if it still
   *   fails the marker stays, recovery parks the row as UNCERTAIN and the
   *   provider's webhook reconciles it);
   * - rejected: the normal retry / dead-letter path;
   * - ambiguous: retried under the same idempotency key when the provider
   *   deduplicates on it (Resend) and retries are left, else UNCERTAIN.
   */
  async function settleProviderCall(
    emailLog: ClaimedEmailLog,
    sendResult: SendEmailResult,
  ): Promise<EmailOutcome> {
    const error = sendResult.error || "Unknown error";
    switch (sendResult.outcome) {
      case "accepted":
        return recordSent(emailLog.id, sendResult.messageId);
      case "rejected":
        return failEmail(emailLog, error, workerId);
      case "ambiguous": {
        const retriesLeft = emailLog.attemptCount <= (emailLog.maxRetries ?? MAX_RETRIES);
        if (sendResult.idempotentRetry && retriesLeft) {
          return failEmail(
            emailLog,
            `Email provider outcome unknown; retrying under the same idempotency key: ${error}`,
            workerId,
          );
        }
        const ok = await markEmailUncertain(
          emailLog.id,
          workerId,
          `Email provider outcome unknown; not resent automatically: ${error}`,
        );
        if (ok) notifyStatusChange(emailLog.id, "UNCERTAIN");
        return ok ? "uncertain" : "lease-lost";
      }
    }
  }

  async function recordSent(
    emailLogId: string,
    messageId: string | undefined,
  ): Promise<EmailOutcome> {
    const written = await retryOutcomeWrite(() => markEmailSent(emailLogId, workerId, messageId));
    if (!written.ok) {
      logger.error(
        { err: written.error, emailLogId, messageId },
        "Email accepted by the provider but not recorded as SENT; left for lease recovery",
      );
      return "unsettled";
    }
    if (written.owned) notifyStatusChange(emailLogId, "SENT");
    return written.owned ? "sent" : "lease-lost";
  }

  // Counts the outcome; true when its write landed (the row was still ours).
  function count(outcome: EmailOutcome): boolean {
    if (outcome === "sent") result.sent++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "skipped") result.skipped++;
    else if (outcome === "uncertain") result.uncertain++;
    // "lease-lost" is a race, not a real failure — silently dropped.
    // "unsettled" wrote nothing: false keeps runLeased from releasing it.
    return outcome !== "lease-lost" && outcome !== "unsettled";
  }

  // Claim → heartbeat → confirm → handle → release (see runLeased).
  await runLeased<ClaimedEmailLog>(emailQueue, {
    workerId,
    limit: batchSize,
    concurrency: CONCURRENCY_LIMIT,
    signal: options.signal,
    leaseMs: options.leaseMs,
    drainUntil: options.drainUntil,
    load: (ids) => getClaimedEmailLogsForProcessing(workerId, ids),
    handle: async (emailLog, { signal }) => {
      result.processed++;
      return count(await processEmail(emailLog, signal));
    },
    // Reached only for a job timeout that interrupted a row before its send:
    // the attempt is charged like any failure. A row whose provider call
    // started is never requeued here (lease recovery settles it).
    onError: async (emailLog, error) =>
      providerCalled.has(emailLog.id)
        ? false
        : count(
            await failEmail(
              emailLog,
              error instanceof Error ? error.message : String(error),
              workerId,
            ),
          ),
  });

  return result;
}

/** A provider call that never throws: an unexpected throw is an ambiguous outcome. */
export async function callEmailProvider(
  provider: EmailProvider,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  try {
    return await provider.sendEmail(input);
  } catch (error: unknown) {
    return ambiguousSend(error instanceof Error ? error.message : String(error));
  }
}

/**
 * An outcome write after the provider call, tried OUTCOME_WRITE_RETRY_DELAYS_MS
 * times: once the provider was called, a failed write must never turn into a
 * requeue. `owned` is the lease-guarded write's answer (false: the row is no
 * longer this worker's); `ok: false` when every try threw, which leaves the
 * row leased with its provider-attempt marker for lease recovery to settle.
 */
export async function retryOutcomeWrite(
  write: () => Promise<boolean>,
): Promise<{ ok: true; owned: boolean } | { ok: false; error: unknown }> {
  let lastError: unknown;
  for (const delayMs of OUTCOME_WRITE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      return { ok: true, owned: await write() };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError };
}

async function failEmail(
  emailLog: Pick<ClaimedEmailLog, "id" | "attemptCount" | "maxRetries">,
  errorMessage: string,
  workerId: string,
): Promise<EmailOutcome> {
  const ok = await markEmailFailed(
    emailLog.id,
    workerId,
    errorMessage,
    emailLog.attemptCount,
    emailLog.maxRetries,
  );
  if (ok) {
    const willRetry = emailLog.attemptCount <= (emailLog.maxRetries ?? MAX_RETRIES);
    notifyStatusChange(emailLog.id, willRetry ? "QUEUED" : "FAILED");
  }
  return ok ? "failed" : "lease-lost";
}

// =============================================================================
// ADMIN RESEND (3.6)
// =============================================================================

/**
 * An admin's explicit resend of an UNCERTAIN email: a new QUEUED log for the
 * worker to send (see resendUncertainEmailLog); the UNCERTAIN log is kept.
 */
export async function resendUncertainEmail(
  eventId: string,
  emailLogId: string,
): Promise<ResendEmailLogResult> {
  const result = await resendUncertainEmailLog(eventId, emailLogId);
  if (result.ok) notifyStatusChange(result.log.id, "QUEUED");
  return result;
}

// =============================================================================
// WEBHOOK STATUS UPDATES
// =============================================================================

/**
 * Forward-only ordering for non-terminal transitions. UNCERTAIN ranks with
 * SENDING: any sign from the provider that it took the email moves it on.
 */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  UNCERTAIN: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
};

/** Terminal statuses that must never be overwritten by a later webhook. */
const TERMINAL_STATUSES = new Set<EmailStatus>(["BOUNCED", "DROPPED", "FAILED"]);

export type WebhookEventType =
  | "processed"
  | "delivered"
  | "open"
  | "click"
  | "bounce"
  | "dropped"
  | "blocked"
  | "spam_report"
  | "unsubscribe";

/**
 * Apply a provider webhook event to an EmailLog, correlated by trackingId =
 * EmailLog.id. Never throws (the webhook route always 200s once verified):
 * unknown log, terminal status, backward transition, and concurrent status
 * change are all silent no-ops; unexpected DB errors are caught + logged.
 */
export async function updateEmailStatusFromWebhook(
  emailLogId: string,
  event: WebhookEventType,
  metadata?: { url?: string; reason?: string },
): Promise<void> {
  const updates: Partial<EmailLogInsert> = {};

  switch (event) {
    case "processed":
      // The provider took the email. Only reconciles an UNCERTAIN log: a
      // SENDING one is its lease owner's to settle.
      updates.status = "SENT";
      updates.sentAt = new Date();
      break;
    case "delivered":
      updates.status = "DELIVERED";
      updates.deliveredAt = new Date();
      break;
    case "open":
      updates.status = "OPENED";
      updates.openedAt = new Date();
      break;
    case "click":
      updates.status = "CLICKED";
      updates.clickedAt = new Date();
      break;
    case "bounce":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage = metadata?.reason || "Bounced";
      break;
    case "dropped":
      updates.status = "DROPPED";
      updates.errorMessage = metadata?.reason || "Dropped";
      break;
    case "blocked":
      updates.status = "DROPPED";
      updates.errorMessage = metadata?.reason || "Blocked by SendGrid";
      break;
    case "spam_report":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage =
        metadata?.reason || "Recipient reported email as spam";
      break;
    case "unsubscribe":
      updates.status = "BOUNCED";
      updates.bouncedAt = new Date();
      updates.errorMessage = metadata?.reason || "Recipient unsubscribed";
      break;
  }

  try {
    const currentStatus = await readEmailLogStatus(emailLogId);
    if (!currentStatus) {
      logger.warn(
        { emailLogId, event },
        "Webhook received for unknown email log — skipping",
      );
      return;
    }

    if (event === "processed" && currentStatus !== "UNCERTAIN") {
      logger.debug(
        { emailLogId, currentStatus },
        "Webhook processed event skipped — only an UNCERTAIN email is reconciled by it",
      );
      return;
    }

    if (TERMINAL_STATUSES.has(currentStatus)) {
      logger.info(
        { emailLogId, event, currentStatus },
        "Webhook skipped — email already in terminal status",
      );
      return;
    }

    const newStatus = updates.status;
    if (newStatus && !TERMINAL_STATUSES.has(newStatus)) {
      const currentRank = STATUS_RANK[currentStatus] ?? -1;
      const newRank = STATUS_RANK[newStatus] ?? -1;
      if (newRank <= currentRank) {
        logger.info(
          { emailLogId, event, currentStatus, newStatus },
          "Webhook skipped — would be a backward status transition",
        );
        return;
      }
    }

    const changed = await updateEmailLogStatusGuarded(
      emailLogId,
      currentStatus,
      updates,
    );
    if (!changed) {
      logger.info(
        { emailLogId, event, currentStatus },
        "Webhook skipped — email status changed concurrently",
      );
      return;
    }
    if (updates.status) notifyStatusChange(emailLogId, updates.status);
  } catch (error) {
    const conflict = pgUniqueViolation(error);
    if (conflict) {
      // An UNCERTAIN email an admin resent: the copy now holds the
      // one-active-email index, so this late confirmation of the original
      // cannot be written. The original stays UNCERTAIN (accepted, 3.6b).
      logger.warn(
        { emailLogId, event, constraint: conflict.constraint },
        "Webhook skipped — another active email for the same trigger holds the unique index",
      );
      return;
    }
    logger.error(
      { emailLogId, event, error },
      "Failed to update email status from webhook",
    );
  }
}

import {
  enqueueSponsorshipEmailOutbox,
  enqueueTriggeredEmailOutbox,
  findActiveEventAccess,
  getSponsorshipEventPricing,
  type DbExecutor,
  type SponsorshipRow,
} from "@app/db";
import {
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@app/integrations";
import type { BatchContext, LinkedEmailEntry } from "./sponsorship-batch.types";
import type { SponsorshipForLink, RegistrationForLink } from "@app/db";

function toEmailEvent(event: Parameters<typeof buildLinkedSponsorshipContext>[0]["event"]) {
  return {
    name: event.name, slug: event.slug, startDate: event.startDate,
    location: event.location, client: { name: event.client.name },
  };
}

function enqueueRegistrantSponsorshipEmail(
  tx: DbExecutor,
  options: {
    trigger: "SPONSORSHIP_LINKED" | "SPONSORSHIP_PARTIAL" | "SPONSORSHIP_APPLIED";
    eventId: string;
    registration: { id: string; email: string; firstName: string | null };
    beneficiaryName: string;
    context: ReturnType<typeof buildLinkedSponsorshipContext>;
    dedupeSuffix: string;
  },
) {
  const { trigger, eventId, registration, beneficiaryName, context, dedupeSuffix } = options;
  return enqueueSponsorshipEmailOutbox(tx, {
    trigger, eventId,
    input: {
      recipientEmail: registration.email,
      recipientName: registration.firstName || beneficiaryName,
      context: context as Record<string, unknown>, registrationId: registration.id,
    },
  }, `email:sponsorship:${trigger}:${registration.id}:${dedupeSuffix}`);
}

/**
 * Batch confirmation to the lab + (auto-approved linked mode) per-beneficiary
 * SPONSORSHIP_LINKED / PAYMENT_CONFIRMED / SPONSORSHIP_PARTIAL emails, all
 * enqueued on the batch transaction (legacy queueBatchEmails parity).
 */
export async function queueBatchEmails(
  tx: DbExecutor,
  context: BatchContext,
  run: {
    eventId: string;
    batchId: string;
    batch: { labName: string; contactName: string; email: string; phone: string | null };
    autoApprove: boolean;
    sponsorships: SponsorshipRow[];
    linkedEmailEntries: LinkedEmailEntry[];
  },
): Promise<void> {
  const { eventId, batchId, batch, autoApprove, sponsorships, linkedEmailEntries } = run;
  const currency = context.pricing?.currency ?? "TND";
  const eventForEmail = toEmailEvent(context.event);

  const batchContext = buildBatchEmailContext({
    batch,
    sponsorships: sponsorships.map((s) => ({
      beneficiaryName: s.beneficiaryName,
      beneficiaryEmail: s.beneficiaryEmail,
      totalAmount: s.totalAmount,
    })),
    event: eventForEmail,
    currency,
  });

  await enqueueSponsorshipEmailOutbox(
    tx,
    {
      trigger: "SPONSORSHIP_BATCH_SUBMITTED",
      eventId,
      input: {
        recipientEmail: batch.email,
        recipientName: batch.contactName,
        context: batchContext as Record<string, unknown>,
      },
    },
    `email:sponsorship:SPONSORSHIP_BATCH_SUBMITTED:${batchId}`,
  );

  if (!context.isLinkedMode || !autoApprove) return;

  for (const entry of linkedEmailEntries) {
    const linkedContext = buildLinkedSponsorshipContext({
      amountApplied: entry.amountApplied,
      sponsorship: {
        ...entry.sponsorship,
        batch: {
          labName: batch.labName,
          contactName: batch.contactName,
          email: batch.email,
        },
      },
      registration: entry.registration,
      event: eventForEmail,
      pricing: context.pricing
        ? { basePrice: context.pricing.basePrice }
        : null,
      accessItems: context.accessItems,
      currency,
    });

    await enqueueRegistrantSponsorshipEmail(tx, {
      trigger: "SPONSORSHIP_LINKED", eventId,
      registration: entry.registration, beneficiaryName: entry.sponsorship.beneficiaryName,
      context: linkedContext, dedupeSuffix: entry.sponsorship.code,
    });

    if (entry.isFullySponsored) {
      await enqueueTriggeredEmailOutbox(
        tx,
        {
          trigger: "PAYMENT_CONFIRMED",
          eventId,
          registration: {
            id: entry.registration.id,
            email: entry.registration.email,
            firstName: entry.registration.firstName,
            lastName: entry.registration.lastName,
          },
        },
        `email:triggered:PAYMENT_CONFIRMED:${entry.registration.id}`,
      );
    } else if (entry.registration.sponsorshipAmount > 0) {
      await enqueueRegistrantSponsorshipEmail(tx, {
        trigger: "SPONSORSHIP_PARTIAL", eventId,
        registration: entry.registration, beneficiaryName: entry.sponsorship.beneficiaryName,
        context: linkedContext, dedupeSuffix: entry.sponsorship.code,
      });
    }
  }
}


export async function queueAppliedSponsorshipEmail(
  tx: DbExecutor,
  input: {
    sponsorship: SponsorshipForLink;
    registration: RegistrationForLink;
    usage: { amountApplied: number };
    newSponsorshipAmount: number;
    sponsorshipId: string;
  },
): Promise<void> {
  const { sponsorship, registration, usage, newSponsorshipAmount, sponsorshipId } = input;
  // SPONSORSHIP_APPLIED email — enqueued on the same txn (legacy parity).
  const [pricing, accessItems] = await Promise.all([
    getSponsorshipEventPricing(tx, sponsorship.eventId),
    findActiveEventAccess(
      tx,
      sponsorship.eventId,
      sponsorship.coveredAccessIds ?? [],
    ),
  ]);
  const currency = pricing?.currency ?? "TND";
  const emailContext = buildLinkedSponsorshipContext({
    amountApplied: usage.amountApplied,
    sponsorship: {
      code: sponsorship.code,
      beneficiaryName: sponsorship.beneficiaryName,
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds ?? [],
      totalAmount: sponsorship.totalAmount,
      batch: {
        labName: sponsorship.batch.labName,
        contactName: sponsorship.batch.contactName,
        email: sponsorship.batch.email,
      },
    },
    registration: { ...registration, sponsorshipAmount: newSponsorshipAmount },
    event: toEmailEvent(sponsorship.event),
    pricing: pricing ? { basePrice: pricing.basePrice } : null,
    accessItems,
    currency,
  });
  await enqueueRegistrantSponsorshipEmail(tx, {
    trigger: "SPONSORSHIP_APPLIED", eventId: sponsorship.eventId,
    registration, beneficiaryName: sponsorship.beneficiaryName,
    context: emailContext, dedupeSuffix: sponsorshipId,
  });

}

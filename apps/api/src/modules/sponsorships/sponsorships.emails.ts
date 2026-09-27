import { enqueueSponsorshipEmailOutbox, type DbExecutor } from "@app/db";
import type { buildLinkedSponsorshipContext } from "@app/integrations";

type EmailEvent = Parameters<typeof buildLinkedSponsorshipContext>[0]["event"];

export function sponsorshipEventForEmail(event: EmailEvent): EmailEvent {
  return {
    name: event.name,
    slug: event.slug,
    startDate: event.startDate,
    location: event.location,
    client: { name: event.client.name },
  };
}

export function queueRegistrantSponsorshipEmail(
  tx: DbExecutor,
  input: {
    trigger: "SPONSORSHIP_APPLIED" | "SPONSORSHIP_LINKED" | "SPONSORSHIP_PARTIAL";
    eventId: string;
    registration: { id: string; email: string; firstName: string | null };
    beneficiaryName: string;
    context: ReturnType<typeof buildLinkedSponsorshipContext>;
    dedupeKey: string;
  },
) {
  return enqueueSponsorshipEmailOutbox(tx, {
    trigger: input.trigger,
    eventId: input.eventId,
    input: {
      recipientEmail: input.registration.email,
      recipientName: input.registration.firstName || input.beneficiaryName,
      context: input.context as Record<string, unknown>,
      registrationId: input.registration.id,
    },
  }, input.dedupeKey);
}

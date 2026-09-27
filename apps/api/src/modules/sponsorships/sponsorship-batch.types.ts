import { type CreateSponsorshipBatchInput } from "@app/contracts";
import {
  findEventForBatch,
  type AccessItemForOverlap,
  type RegistrationForBatch,
} from "@app/db";

export interface BatchContext {
  event: Awaited<ReturnType<typeof findEventForBatch>> & object;
  formId: string;
  pricing: { basePrice: number; currency: string } | null;
  accessItems: AccessItemForOverlap[];
  isLinkedMode: boolean;
  beneficiaries: CreateSponsorshipBatchInput["beneficiaries"];
  linkedBeneficiaries: CreateSponsorshipBatchInput["linkedBeneficiaries"];
  registrations: Map<string, RegistrationForBatch>;
}

/** Auto-approved linked-mode entry captured for post-create email enqueue. */
export interface LinkedEmailEntry {
  amountApplied: number;
  isFullySponsored: boolean;
  sponsorship: {
    code: string;
    beneficiaryName: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  };
  registration: RegistrationForBatch;
}

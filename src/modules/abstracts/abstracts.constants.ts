import { AbstractFinalType, AbstractStatus } from "@/generated/prisma/client.js";

export const FINAL_STATUSES: AbstractStatus[] = [
  AbstractStatus.ACCEPTED,
  AbstractStatus.REJECTED,
  AbstractStatus.PENDING,
];

export const CODE_SUFFIX: Record<AbstractFinalType, string> = {
  [AbstractFinalType.ORAL_COMMUNICATION]: "OC",
  [AbstractFinalType.POSTER]: "PO",
};

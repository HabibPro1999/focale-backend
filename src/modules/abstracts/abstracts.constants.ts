import { AbstractFinalType, AbstractStatus } from "@/generated/prisma/client.js";

export const FINAL_STATUSES: AbstractStatus[] = [
  AbstractStatus.ACCEPTED,
  AbstractStatus.REJECTED,
  AbstractStatus.PENDING,
];

export const CODE_SUFFIX: Record<AbstractFinalType, string> = {
  [AbstractFinalType.CONFERENCE]: "CONF",
  [AbstractFinalType.ORAL_COMMUNICATION]: "OC",
  [AbstractFinalType.POSTER]: "PC",
};

export const FINAL_TYPE_SORT_ORDER: Record<AbstractFinalType, number> = {
  [AbstractFinalType.CONFERENCE]: 0,
  [AbstractFinalType.ORAL_COMMUNICATION]: 1,
  [AbstractFinalType.POSTER]: 2,
};

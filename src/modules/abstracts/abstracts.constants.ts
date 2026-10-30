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

export const ABSTRACT_STATUS_LABELS_FR: Record<AbstractStatus, string> = {
  [AbstractStatus.SUBMITTED]: "Soumis",
  [AbstractStatus.UNDER_REVIEW]: "En cours d'évaluation",
  [AbstractStatus.REVIEW_COMPLETE]: "Évaluation terminée",
  [AbstractStatus.ACCEPTED]: "Accepté",
  [AbstractStatus.REJECTED]: "Refusé",
  [AbstractStatus.PENDING]: "En attente",
};

export const ABSTRACT_TYPE_LABELS_FR: Record<AbstractFinalType, string> = {
  [AbstractFinalType.CONFERENCE]: "Conférence",
  [AbstractFinalType.ORAL_COMMUNICATION]: "Communication orale",
  [AbstractFinalType.POSTER]: "Communication affichée",
};

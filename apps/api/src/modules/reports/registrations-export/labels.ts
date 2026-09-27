import type { ExportLanguage, IdentityField, SubmissionField, PaymentField, SponsorshipField } from "@app/contracts";

export type GroupKey = "identity" | "submission" | "payment" | "sponsorship" | "access" | "checkins" | "transactions" | "form";

export const GROUP_LABELS: Record<GroupKey, Record<ExportLanguage, string>> = {
  identity: { fr: "Identité", en: "Identity", ar: "الهوية" },
  submission: { fr: "Soumission", en: "Submission", ar: "الإرسال" },
  payment: { fr: "Paiement", en: "Payment", ar: "الدفع" },
  sponsorship: { fr: "Sponsoring", en: "Sponsorship", ar: "الرعاية" },
  access: { fr: "Accès", en: "Access items", ar: "الوصول" },
  checkins: { fr: "Pointages", en: "Check-ins", ar: "التسجيلات" },
  transactions: { fr: "Transactions", en: "Transactions", ar: "المعاملات" },
  form: {
    fr: "Questions du formulaire",
    en: "Form questions",
    ar: "أسئلة النموذج",
  },
};

export const IDENTITY_HEADERS: Record<IdentityField, Record<ExportLanguage, string>> = {
  id: { fr: "ID", en: "ID", ar: "المعرف" },
  referenceNumber: { fr: "N° de référence", en: "Reference #", ar: "المرجع" },
  email: { fr: "Email", en: "Email", ar: "البريد" },
  firstName: { fr: "Prénom", en: "First name", ar: "الاسم" },
  lastName: { fr: "Nom", en: "Last name", ar: "اللقب" },
  phone: { fr: "Téléphone", en: "Phone", ar: "الهاتف" },
  role: { fr: "Rôle", en: "Role", ar: "الدور" },
  note: { fr: "Note admin", en: "Admin note", ar: "ملاحظة" },
};

export const SUBMISSION_HEADERS: Record<SubmissionField, Record<ExportLanguage, string>> = {
  submittedAt: { fr: "Soumis le", en: "Submitted at", ar: "تاريخ الإرسال" },
  createdAt: { fr: "Créé le", en: "Created at", ar: "تاريخ الإنشاء" },
  updatedAt: { fr: "Mis à jour le", en: "Updated at", ar: "آخر تحديث" },
  lastEditedAt: {
    fr: "Dernière édition",
    en: "Last edited",
    ar: "آخر تعديل",
  },
  formSchemaVersion: {
    fr: "Version du formulaire",
    en: "Form version",
    ar: "إصدار النموذج",
  },
};

export const PAYMENT_HEADERS: Record<PaymentField, Record<ExportLanguage, string>> = {
  paymentStatus: { fr: "Statut de paiement", en: "Payment status", ar: "حالة" },
  paymentMethod: { fr: "Méthode", en: "Method", ar: "الطريقة" },
  currency: { fr: "Devise", en: "Currency", ar: "العملة" },
  totalAmount: { fr: "Total", en: "Total", ar: "المجموع" },
  paidAmount: { fr: "Payé", en: "Paid", ar: "المدفوع" },
  baseAmount: { fr: "Base", en: "Base", ar: "الأساس" },
  accessAmount: { fr: "Accès (mt)", en: "Access amount", ar: "مبلغ الوصول" },
  discountAmount: { fr: "Remise", en: "Discount", ar: "خصم" },
  sponsorshipAmount: { fr: "Sponsoring (mt)", en: "Sponsorship", ar: "رعاية" },
  paymentReference: { fr: "Référence", en: "Reference", ar: "مرجع" },
  paymentProofUrl: { fr: "Preuve (URL)", en: "Proof URL", ar: "إثبات" },
  paidAt: { fr: "Payé le", en: "Paid at", ar: "تاريخ الدفع" },
};

export const SPONSORSHIP_HEADERS: Record<SponsorshipField, Record<ExportLanguage, string>> = {
  sponsorshipCode: { fr: "Code", en: "Code", ar: "رمز" },
  labName: { fr: "Laboratoire", en: "Lab", ar: "مخبر" },
  labContactName: { fr: "Contact labo", en: "Lab contact", ar: "جهة الاتصال" },
  labEmail: { fr: "Email labo", en: "Lab email", ar: "بريد" },
  labPhone: { fr: "Téléphone labo", en: "Lab phone", ar: "هاتف" },
  beneficiaryAddress: {
    fr: "Adresse bénéficiaire",
    en: "Beneficiary address",
    ar: "عنوان",
  },
};

export const PAYMENT_STATUS_LABELS: Record<string, Record<ExportLanguage, string>> = {
  PENDING: { fr: "En attente", en: "Pending", ar: "معلق" },
  VERIFYING: { fr: "En vérification", en: "Verifying", ar: "قيد التحقق" },
  PARTIAL: { fr: "Partiel", en: "Partial", ar: "جزئي" },
  PAID: { fr: "Payé", en: "Paid", ar: "مدفوع" },
  SPONSORED: { fr: "Sponsorisé", en: "Sponsored", ar: "مرعي" },
  WAIVED: { fr: "Exonéré", en: "Waived", ar: "معفى" },
  REFUNDED: { fr: "Remboursé", en: "Refunded", ar: "مسترد" },
};

/** French report labels share the report catalogue; unknown statuses keep the caller fallback. */
export const PAYMENT_STATUS_FR: Record<string, string> = Object.fromEntries(
  ["PAID", "SPONSORED", "WAIVED", "PARTIAL", "VERIFYING", "PENDING", "REFUNDED"].map(
    (status) => [status, PAYMENT_STATUS_LABELS[status].fr],
  ),
);

export const PAYMENT_METHOD_LABELS: Record<string, Record<ExportLanguage, string>> = {
  BANK_TRANSFER: { fr: "Virement", en: "Bank transfer", ar: "تحويل" },
  ONLINE: { fr: "En ligne", en: "Online", ar: "عبر الإنترنت" },
  CASH: { fr: "Espèces", en: "Cash", ar: "نقدا" },
  LAB_SPONSORSHIP: {
    fr: "Sponsoring labo",
    en: "Lab sponsorship",
    ar: "رعاية مخبر",
  },
};

export const ROLE_LABELS: Record<string, Record<ExportLanguage, string>> = {
  PARTICIPANT: { fr: "Participant", en: "Participant", ar: "مشارك" },
  SPEAKER: { fr: "Intervenant", en: "Speaker", ar: "متحدث" },
  MODERATOR: { fr: "Modérateur", en: "Moderator", ar: "مشرف" },
  ORGANIZER: { fr: "Organisateur", en: "Organizer", ar: "منظم" },
};

export const TX_TYPE_LABELS: Record<string, Record<ExportLanguage, string>> = {
  PAYMENT: { fr: "Paiement", en: "Payment", ar: "دفع" },
  REFUND: { fr: "Remboursement", en: "Refund", ar: "استرداد" },
  WAIVER: { fr: "Exonération", en: "Waiver", ar: "إعفاء" },
  ADJUSTMENT: { fr: "Ajustement", en: "Adjustment", ar: "تعديل" },
};

export const YES_NO: Record<ExportLanguage, { yes: string; no: string }> = {
  fr: { yes: "Oui", no: "Non" },
  en: { yes: "Yes", no: "No" },
  ar: { yes: "نعم", no: "لا" },
};

export const SHEET_NAME: Record<ExportLanguage, string> = {
  fr: "Inscriptions",
  en: "Registrations",
  ar: "التسجيلات",
};

export const TRANSACTIONS_HEADER = GROUP_LABELS.transactions;

export const DROPPED_ACCESS_HEADER: Record<ExportLanguage, string> = {
  fr: "Accès retirés",
  en: "Dropped access",
  ar: "الوصول المزال",
};

export const GLOBAL_CHECKIN_AT: Record<ExportLanguage, string> = {
  fr: "Pointage global",
  en: "Global check-in",
  ar: "تسجيل عام",
};
export const GLOBAL_CHECKIN_BY: Record<ExportLanguage, string> = {
  fr: "Pointé par",
  en: "Checked in by",
  ar: "تم تسجيله بواسطة",
};
export const CHECKIN_SUFFIX: Record<ExportLanguage, string> = {
  fr: "— Pointage",
  en: "— Check-in",
  ar: "— تسجيل",
};

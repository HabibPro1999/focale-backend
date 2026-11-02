import type { LanguageCode } from "@app/contracts";
import type { VariableDefinition } from "./types";

/** Labels and help text only; variable IDs and category keys are stable. */
const translations: Record<string, [string, string, string, string]> = {
  firstName: ["Prénom", "Prénom de la personne inscrite", "الاسم الأول", "الاسم الأول للمشارك"],
  lastName: ["Nom", "Nom de famille de la personne inscrite", "اسم العائلة", "اسم عائلة المشارك"],
  fullName: ["Nom complet", "Prénom et nom réunis", "الاسم الكامل", "الاسم الأول واسم العائلة"],
  email: ["E-mail", "Adresse e-mail de la personne inscrite", "البريد الإلكتروني", "عنوان البريد الإلكتروني للمشارك"],
  phone: ["Téléphone", "Numéro de téléphone de la personne inscrite", "الهاتف", "رقم هاتف المشارك"],
  registrationDate: ["Date d’inscription", "Date à laquelle l’inscription a été soumise", "تاريخ التسجيل", "تاريخ إرسال التسجيل"],
  eventName: ["Nom de l’événement", "Nom de l’événement", "اسم الفعالية", "اسم الفعالية"],
  eventDate: ["Début de l’événement", "Date de début de l’événement", "بداية الفعالية", "تاريخ بداية الفعالية"],
  eventEndDate: ["Fin de l’événement", "Date de fin de l’événement", "نهاية الفعالية", "تاريخ نهاية الفعالية"],
  eventLocation: ["Lieu", "Lieu où se déroule l’événement", "المكان", "مكان انعقاد الفعالية"],
  totalAmount: ["Montant total", "Coût total de l’inscription", "المبلغ الإجمالي", "التكلفة الإجمالية للتسجيل"],
  paidAmount: ["Montant payé", "Montant déjà réglé", "المبلغ المدفوع", "المبلغ الذي تم دفعه"],
  amountDue: ["Reste à payer", "Montant restant à régler", "المبلغ المستحق", "المبلغ المتبقي للدفع"],
  paymentStatus: ["Statut du paiement", "État actuel du paiement", "حالة الدفع", "الحالة الحالية للدفع"],
  selectedAccess: ["Accès sélectionnés", "Ateliers, repas et autres accès choisis", "الأنشطة المختارة", "الورشات والوجبات والأنشطة المختارة"],
  registrationLink: ["Lien de l’inscription", "Lien pour consulter l’inscription", "رابط التسجيل", "رابط الاطلاع على التسجيل"],
  editRegistrationLink: ["Lien de modification", "Lien pour modifier l’inscription", "رابط التعديل", "رابط تعديل التسجيل"],
  paymentLink: ["Lien de paiement", "Lien vers la page de paiement", "رابط الدفع", "رابط صفحة الدفع"],
  organizerName: ["Organisateur", "Nom de l’organisme organisateur", "المنظم", "اسم الجهة المنظمة"],
  organizerEmail: ["E-mail de l’organisateur", "Adresse e-mail de contact", "بريد المنظم", "عنوان البريد الإلكتروني للتواصل"],
  organizerPhone: ["Téléphone de l’organisateur", "Numéro de téléphone de contact", "هاتف المنظم", "رقم هاتف التواصل"],
  bankName: ["Banque", "Nom de la banque", "البنك", "اسم البنك"],
  bankAccountName: ["Titulaire du compte", "Nom du titulaire du compte bancaire", "صاحب الحساب", "اسم صاحب الحساب البنكي"],
  bankAccountNumber: ["Compte bancaire / IBAN", "Numéro du compte bancaire ou IBAN", "الحساب البنكي / IBAN", "رقم الحساب البنكي أو IBAN"],
  certificateCount: ["Nombre de certificats", "Nombre de certificats joints à l’e-mail", "عدد الشهادات", "عدد الشهادات المرفقة بالرسالة"],
  certificateList: ["Liste des certificats", "Noms des certificats joints", "قائمة الشهادات", "أسماء الشهادات المرفقة"],
  labName: ["Laboratoire", "Nom du laboratoire qui assure la prise en charge", "المختبر", "اسم المختبر المتكفل بالتكاليف"],
  labContactName: ["Contact du laboratoire", "Nom de la personne à contacter au laboratoire", "مسؤول التواصل بالمختبر", "اسم الشخص المسؤول عن التواصل بالمختبر"],
  labEmail: ["E-mail du laboratoire", "Adresse e-mail de contact du laboratoire", "بريد المختبر", "البريد الإلكتروني للتواصل مع المختبر"],
  sponsorshipCode: ["Code de prise en charge", "Code unique de la prise en charge", "رمز التكفل", "الرمز الفريد للتكفل"],
  sponsorshipAmount: ["Montant pris en charge", "Montant total couvert par la prise en charge", "مبلغ التكفل", "المبلغ الإجمالي المشمول بالتكفل"],
  beneficiaryName: ["Bénéficiaire", "Nom de la personne bénéficiaire", "المستفيد", "اسم الشخص المستفيد من التكفل"],
  beneficiaryCount: ["Nombre de bénéficiaires", "Nombre de personnes dans le lot", "عدد المستفيدين", "عدد المستفيدين في المجموعة"],
  totalBatchAmount: ["Montant total du lot", "Total des prises en charge du lot", "إجمالي المجموعة", "إجمالي مبالغ التكفل في المجموعة"],
  beneficiaryList: ["Liste des bénéficiaires", "Bénéficiaires et montants du lot", "قائمة المستفيدين", "المستفيدون ومبالغ التكفل في المجموعة"],
  sponsoredItems: ["Éléments pris en charge", "Liste des éléments couverts", "العناصر المشمولة", "قائمة العناصر المشمولة بالتكفل"],
  remainingAmount: ["Montant restant", "Montant restant après la prise en charge", "المبلغ المتبقي", "المبلغ المتبقي بعد التكفل"],
  reviewerName: ["Membre du comité", "Nom du membre invité au comité scientifique", "عضو اللجنة", "اسم العضو المدعو إلى اللجنة العلمية"],
  loginLink: ["Lien du comité", "Lien sécurisé pour définir un mot de passe et accéder au comité", "رابط اللجنة", "رابط آمن لتعيين كلمة مرور والدخول إلى اللجنة"],
};
export function localizeVariable(variable: VariableDefinition, language: LanguageCode): VariableDefinition {
  if (language === "en") return { ...variable };
  const entry = translations[variable.id];
  if (!entry) throw new Error(`Missing variable translation: ${variable.id}`);
  const [label, description] = language === "fr" ? entry.slice(0, 2) : entry.slice(2);
  return { ...variable, label, description };
}
export function formVariableDescription(label: string, language: LanguageCode) {
  return language === "fr" ? `Champ du formulaire : ${label}` : language === "ar" ? `حقل النموذج: ${label}` : `Form field: ${label}`;
}

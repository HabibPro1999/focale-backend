import type { NetworkingExportContact } from "@app/db";
import { toCsv } from "@app/shared";
import type { EmailAttachment } from "../email/providers";
export function networkingContactAttachment(contacts: NetworkingExportContact[], language: "fr" | "en" | "ar"): EmailAttachment {
  const headers = { en: ["First name", "Last name", "Company", "Role", "Sector", "City", "Country", "Website"], fr: ["Prénom", "Nom", "Entreprise", "Fonction", "Secteur", "Ville", "Pays", "Site web"], ar: ["الاسم", "اللقب", "الشركة", "الوظيفة", "القطاع", "المدينة", "البلد", "الموقع الإلكتروني"] }[language];
  const rows = contacts.map(contact => [contact.firstName, contact.lastName, contact.company, contact.jobTitle, contact.sector, contact.city, contact.country, contact.website]);
  return { filename: "networking-connections.csv", type: "text/csv; charset=utf-8", disposition: "attachment", content: Buffer.from(toCsv([headers, ...rows])).toString("base64") };
}

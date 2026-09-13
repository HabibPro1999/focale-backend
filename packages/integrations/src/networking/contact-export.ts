import type { NetworkingExportContact } from "@app/db";
import type { EmailAttachment } from "../email/providers";
function cell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function networkingContactAttachment(contacts: NetworkingExportContact[], language: "fr" | "en" | "ar"): EmailAttachment {
  const headers = { en: ["First name", "Last name", "Company", "Role", "Sector", "City", "Country", "Website"], fr: ["Prénom", "Nom", "Entreprise", "Fonction", "Secteur", "Ville", "Pays", "Site web"], ar: ["الاسم", "اللقب", "الشركة", "الوظيفة", "القطاع", "المدينة", "البلد", "الموقع الإلكتروني"] }[language];
  const rows = contacts.map(contact => [contact.firstName, contact.lastName, contact.company, contact.jobTitle, contact.sector, contact.city, contact.country, contact.website]);
  return { filename: "networking-connections.csv", type: "text/csv; charset=utf-8", disposition: "attachment", content: Buffer.from("\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n").toString("base64") };
}

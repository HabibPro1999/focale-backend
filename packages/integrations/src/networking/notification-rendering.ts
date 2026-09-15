import { createDecipheriv, createHash } from "node:crypto";
import type { networkingDeliveryContext } from "@app/db";
import type { EmailAttachment } from "../email/providers";
export type NetworkingNotificationContext = Awaited<
  ReturnType<typeof networkingDeliveryContext>
>;
type Language = "en" | "fr" | "ar";
const copy = {
  en: {
    OTP: "Your networking sign-in code",
    MATCH: "You have a new connection",
    MESSAGE: "You have a new message",
    APPROVAL: "Your networking access is approved",
    DAILY_DIGEST: "Your networking daily summary",
    POST_EVENT_CONTACTS: "Your post-event connections",
    contactSummary: "Your connection export is ready. Eligible connections included",
    MODERATION_WARNING: "A message from the event organizer",
    MEETING_REQUEST: "You received a meeting request",
    MEETING_REQUEST_SENT: "Your meeting request was sent",
    MEETING_ACCEPT: "Your meeting is confirmed",
    MEETING_PENDING_ALLOCATION: "Your meeting is accepted; a place is being assigned",
    instructions: "Access instructions",
    plan: "Access plan",
    cancellation: "Cancellation reason",
    MEETING_DECLINE: "The meeting request was declined",
    MEETING_CANCEL: "Your meeting was cancelled",
    MEETING_RESCHEDULE: "A new meeting time was proposed",
    MEETING_REMINDER_DAY: "Your meeting is tomorrow",
    MEETING_REMINDER_HOUR: "Your meeting starts within an hour",
    MEETING_COMPLETED: "Your meeting attendance is confirmed",
    MEETING_NO_SHOW: "Meeting attendance was not confirmed",
    open: "Open networking",
    code: "Your sign-in code is",
    expires: "Valid until",
    secret: "Do not share this code.",
    digest: "Unread updates in your networking space",
    contact: "Contact",
    time: "Meeting time",
    proposed: "Proposed new time",
    retained:
      "The current booking stays reserved until the new time is accepted.",
    table: "Meeting place",
    unallocated: "The organizer will assign a meeting place.",
    status: "Status",
    message: "Message",
    from: "A message from",
    matched:
      "You and this participant expressed mutual interest. You can now start a conversation.",
    approved:
      "Your profile is ready. Complete your offer and needs, discover participants and arrange meetings with your connections.",
    moderation:
      "The organizer has an update about your networking participation.",
    support: "Contact the organizer for help.",
  },
  fr: {
    OTP: "Votre code de connexion networking",
    MATCH: "Vous avez une nouvelle connexion",
    MESSAGE: "Vous avez un nouveau message",
    APPROVAL: "Votre accès networking est validé",
    DAILY_DIGEST: "Votre résumé networking quotidien",
    POST_EVENT_CONTACTS: "Vos connexions après l’événement",
    contactSummary: "Votre export de connexions est prêt. Connexions éligibles incluses",
    MODERATION_WARNING: "Un message de l’organisateur",
    MEETING_REQUEST: "Vous avez reçu une demande de rendez-vous",
    MEETING_REQUEST_SENT: "Votre demande de rendez-vous a été envoyée",
    MEETING_ACCEPT: "Votre rendez-vous est confirmé",
    MEETING_PENDING_ALLOCATION: "Votre rendez-vous est accepté ; le lieu reste à attribuer",
    instructions: "Instructions d’accès",
    plan: "Plan d’accès",
    cancellation: "Motif de l’annulation",
    MEETING_DECLINE: "La demande de rendez-vous a été refusée",
    MEETING_CANCEL: "Votre rendez-vous a été annulé",
    MEETING_RESCHEDULE: "Un nouveau créneau a été proposé",
    MEETING_REMINDER_DAY: "Votre rendez-vous a lieu demain",
    MEETING_REMINDER_HOUR: "Votre rendez-vous commence dans une heure",
    MEETING_COMPLETED: "Votre rencontre a été confirmée",
    MEETING_NO_SHOW: "La présence au rendez-vous n’a pas été confirmée",
    open: "Ouvrir le networking",
    code: "Votre code de connexion est",
    expires: "Valable jusqu’au",
    secret: "Ne partagez pas ce code.",
    digest: "Notifications non lues dans votre espace networking",
    contact: "Contact",
    time: "Date et heure",
    proposed: "Nouveau créneau proposé",
    retained:
      "Le rendez-vous actuel reste réservé jusqu’à l’acceptation du nouveau créneau.",
    table: "Lieu de rendez-vous",
    unallocated: "L’organisateur attribuera un lieu de rendez-vous.",
    status: "Statut",
    message: "Message",
    from: "Un message de",
    matched:
      "Votre intérêt est réciproque. Vous pouvez maintenant démarrer une conversation avec ce participant.",
    approved:
      "Votre profil est prêt. Précisez vos offres et vos besoins, découvrez les participants et organisez vos rencontres avec vos connexions.",
    moderation:
      "L’organisateur a une information concernant votre participation au networking.",
    support: "Contactez l’organisateur pour obtenir de l’aide.",
  },
  ar: {
    OTP: "رمز الدخول إلى مساحة التواصل",
    MATCH: "لديك اتصال جديد",
    MESSAGE: "لديك رسالة جديدة",
    APPROVAL: "تمت الموافقة على دخولك",
    DAILY_DIGEST: "ملخص التواصل اليومي",
    POST_EVENT_CONTACTS: "علاقاتك بعد الحدث",
    contactSummary: "تصدير علاقاتك جاهز. عدد العلاقات المؤهّلة المضمّنة",
    MODERATION_WARNING: "رسالة من منظّم الفعالية",
    MEETING_REQUEST: "لديك طلب لقاء جديد",
    MEETING_REQUEST_SENT: "تم إرسال طلب اللقاء",
    MEETING_ACCEPT: "تم تأكيد موعدك",
    MEETING_PENDING_ALLOCATION: "تم قبول موعدك وبانتظار تحديد المكان",
    instructions: "تعليمات الدخول",
    plan: "خريطة الوصول",
    cancellation: "سبب الإلغاء",
    MEETING_DECLINE: "تم رفض طلب اللقاء",
    MEETING_CANCEL: "تم إلغاء موعدك",
    MEETING_RESCHEDULE: "تم اقتراح وقت جديد للقاء",
    MEETING_REMINDER_DAY: "موعدك غداً",
    MEETING_REMINDER_HOUR: "يبدأ موعدك خلال ساعة",
    MEETING_COMPLETED: "تم تأكيد حضور اللقاء",
    MEETING_NO_SHOW: "لم يتم تأكيد حضور اللقاء",
    open: "فتح مساحة التواصل",
    code: "رمز الدخول هو",
    expires: "صالح حتى",
    secret: "لا تشارك هذا الرمز مع أي شخص.",
    digest: "التحديثات غير المقروءة في مساحة التواصل",
    contact: "جهة الاتصال",
    time: "موعد اللقاء",
    proposed: "الوقت الجديد المقترح",
    retained: "يبقى الموعد الحالي محجوزاً حتى قبول الوقت الجديد.",
    table: "مكان اللقاء",
    unallocated: "سيحدّد المنظّم مكان اللقاء.",
    status: "الحالة",
    message: "الرسالة",
    from: "رسالة من",
    matched: "أبديتما اهتماماً متبادلاً. يمكنكما الآن بدء محادثة.",
    approved:
      "ملفك جاهز. حدّد ما تقدّمه وما تبحث عنه، واكتشف المشاركين ورتّب لقاءات مع معارفك.",
    moderation: "لدى المنظّم تحديث بشأن مشاركتك في التواصل المهني.",
    support: "اتصل بالمنظّم للمساعدة.",
  },
};
const statuses = {
  en: {
    PENDING: "Awaiting response",
    PENDING_ALLOCATION: "Awaiting a meeting place",
    CONFIRMED: "Confirmed",
    DECLINED: "Declined",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired",
    COMPLETED: "Completed",
    NO_SHOW: "No show",
  },
  fr: {
    PENDING: "En attente de réponse",
    PENDING_ALLOCATION: "Lieu à attribuer",
    CONFIRMED: "Confirmé",
    DECLINED: "Refusé",
    CANCELLED: "Annulé",
    EXPIRED: "Expiré",
    COMPLETED: "Effectué",
    NO_SHOW: "Absence",
  },
  ar: {
    PENDING: "بانتظار الرد",
    PENDING_ALLOCATION: "بانتظار تخصيص المكان",
    CONFIRMED: "مؤكّد",
    DECLINED: "مرفوض",
    CANCELLED: "ملغى",
    EXPIRED: "منتهي",
    COMPLETED: "مكتمل",
    NO_SHOW: "عدم الحضور",
  },
};
function normalizedType(type: string) {
  return (
    (
      {
        MEETING_CONFIRMED: "MEETING_ACCEPT",
        MEETING_CANCELLED: "MEETING_CANCEL",
        MEETING_DECLINED: "MEETING_DECLINE",
        MEETING_RESCHEDULED: "MEETING_RESCHEDULE",
        MEETING_ASSIGNED: "MEETING_ACCEPT",
        MEETING_ASSIGN: "MEETING_ACCEPT",
        WELCOME: "APPROVAL",
      } as Record<string, string>
    )[type] ?? type
  );
}
export function escapeNetworkingHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
export function decryptNetworkingCode(value: string, secret: string): string {
  if (secret.length < 32)
    throw new Error("Networking secret is not configured");
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted code");
  const [iv, tag, encrypted] = parts.map((part) =>
    Buffer.from(part, "base64url"),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    iv!,
  );
  decipher.setAuthTag(tag!);
  const code = Buffer.concat([
    decipher.update(encrypted!),
    decipher.final(),
  ]).toString("utf8");
  if (!/^\d{6}$/.test(code)) throw new Error("Invalid encrypted code");
  return code;
}
function icsEscape(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
function icsTime(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
function foldIcs(value: string) {
  let output = "",
    part = "";
  for (const character of value) {
    if (Buffer.byteLength(part + character, "utf8") > 73) {
      output += part + "\r\n ";
      part = "";
    }
    part += character;
  }
  return output + part;
}
function notificationContact(ctx: NetworkingNotificationContext) {
  const contact = ctx.contact;
  return contact && !ctx.blocked && contact.status === "ACTIVE" && contact.consent && !contact.withdrawnAt &&
    ctx.contactRegistration?.networkingOptIn !== false && ctx.contactRegistration &&
    ctx.config.eligiblePaymentStatuses.includes(ctx.contactRegistration.paymentStatus) ? contact : null;
}
export function networkingMeetingAttachment(
  ctx: NetworkingNotificationContext,
): EmailAttachment[] {
  const meeting = ctx.meeting;
  if (
    !meeting ||
    !["CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"].includes(meeting.status)
  )
    return [];
  const cancelled = meeting.status === "CANCELLED";
  const contact = notificationContact(ctx);
  const lang = (ctx.profile?.language ??
    ctx.config.defaultLanguage) as Language;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Focale//Networking//EN",
    `METHOD:${cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${meeting.id}@networking.focale`,
    `SEQUENCE:${meeting.revision}`,
    `DTSTAMP:${icsTime(meeting.updatedAt)}`,
    `DTSTART:${icsTime(meeting.startsAt)}`,
    `DTEND:${icsTime(meeting.endsAt)}`,
    `SUMMARY:${icsEscape([ctx.event?.name ?? "Networking", contact?.firstName, contact?.lastName].filter(Boolean).join(" "))}`,
    `LOCATION:${icsEscape([ctx.table?.name, ctx.table?.location].filter(Boolean).join(" - "))}`,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    ...(!cancelled
      ? [
          "BEGIN:VALARM",
          "TRIGGER:-P1D",
          "ACTION:DISPLAY",
          `DESCRIPTION:${icsEscape(copy[lang].MEETING_REMINDER_DAY)}`,
          "END:VALARM",
          "BEGIN:VALARM",
          "TRIGGER:-PT1H",
          "ACTION:DISPLAY",
          `DESCRIPTION:${icsEscape(copy[lang].MEETING_REMINDER_HOUR)}`,
          "END:VALARM",
        ]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return [
    {
      content: Buffer.from(lines.map(foldIcs).join("\r\n") + "\r\n").toString(
        "base64",
      ),
      filename: "networking-meeting.ics",
      type: `text/calendar; method=${cancelled ? "CANCEL" : "PUBLISH"}; charset=utf-8`,
      disposition: "attachment",
    },
  ];
}
export function renderNetworkingNotification(
  type: string,
  payload: Record<string, unknown>,
  ctx: NetworkingNotificationContext,
) {
  const lang = (ctx.profile?.language ??
    ctx.config.defaultLanguage) as Language;
  const words = copy[lang];
  const meeting = ctx.meeting;
  const eventType = normalizedType(type);
  const normalized = eventType === "MEETING_ACCEPT" && meeting?.status === "PENDING_ALLOCATION"
    ? "MEETING_PENDING_ALLOCATION"
    : eventType === "MEETING_ACCEPT" && meeting?.status === "PENDING"
      ? "MEETING_REQUEST" : eventType;
  const title = words[normalized as keyof typeof words] ?? words.MESSAGE;
  const slug = encodeURIComponent(ctx.event?.slug ?? "");
  const relativeHref = `/e/${slug}/${type.startsWith("MEETING_") ? "agenda" : ctx.connection ? `connections/${encodeURIComponent(ctx.connection.id)}` : normalized === "APPROVAL" ? "profile" : "notifications"}`;
  let href = "";
  try {
    const base = new URL(process.env.PUBLIC_NETWORKING_URL ?? "");
    if (
      ["https:", "http:"].includes(base.protocol) &&
      !base.username &&
      !base.password
    )
      href = new URL(relativeHref, base.origin).toString();
  } catch {
    /* Missing configuration must not create a deceptive link. */
  }
  const format = (date: Date) =>
    new Intl.DateTimeFormat(lang, {
      timeZone: ctx.config.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(date);
  const contact = notificationContact(ctx);
  const contactName = [contact?.firstName, contact?.lastName]
    .filter(Boolean)
    .join(" ");
  const vars: Record<string, string> = {
    prenom: ctx.profile?.firstName ?? "",
    nom_contact: contactName,
    entreprise_contact: contact?.company ?? "",
    fonction_contact: contact?.jobTitle ?? "",
    heure_rdv: meeting ? format(meeting.startsAt) : "",
    heure_fin_rdv: meeting ? format(meeting.endsAt) : "",
    numero_table: ctx.table?.name ?? "",
    lieu_rdv: ctx.table?.location ?? "",
    lien: href,
    message: ctx.message?.body.slice(0, 180) ?? "",
    statut: meeting ? statuses[lang][meeting.status] : "",
    instructions_acces: ctx.config.accessInstructions ?? "",
    plan_acces: ctx.config.accessPlanUrl ?? "",
    telephone_assistance: ctx.config.supportPhone ?? "",
    motif_annulation: meeting?.cancellationNote ?? "",
  };
  const contactLabel = [contactName, contact?.jobTitle, contact?.company].filter(Boolean).join(" · ");
  let body = title;
  if (normalized === "POST_EVENT_CONTACTS") body = `${words.contactSummary}: ${Number(payload.contactCount ?? 0)}`;
  if (normalized === "APPROVAL") body = words.approved;
  else if (normalized === "MATCH")
    body = [contactLabel, words.matched].filter(Boolean).join("\n\n");
  else if (normalized === "MESSAGE")
    body = [`${words.from} ${contactLabel}`, vars.message]
      .filter(Boolean)
      .join("\n\n");
  else if (normalized === "MODERATION_WARNING")
    body = [
      words.moderation,
      typeof payload.note === "string"
        ? payload.note.slice(0, 4000)
        : typeof payload.body === "string"
          ? payload.body.slice(0, 4000)
          : "",
      words.support,
    ]
      .filter(Boolean)
      .join("\n\n");
  else if (normalized === "DAILY_DIGEST") {
    const summaries = Array.isArray(payload.digestSummaries)
      ? payload.digestSummaries.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    body = `${words.digest}: ${summaries.length}\n\n${summaries.join("\n\n")}`;
  }
  if (meeting)
    body = [
      title,
      ...(contactLabel ? [`${words.contact}: ${contactLabel}`] : []),
      `${words.time}: ${vars.heure_rdv} – ${vars.heure_fin_rdv}`,
      ...(meeting.proposedStartsAt
        ? [
            `${words.proposed}: ${format(meeting.proposedStartsAt)} – ${format(new Date(meeting.proposedStartsAt.getTime() + ctx.config.slotDurationMinutes * 60_000))}`,
            ...(meeting.status === "CONFIRMED" ? [words.retained] : []),
          ]
        : []),
      ctx.table
        ? `${words.table}: ${ctx.table.name}${ctx.table.location ? ` · ${ctx.table.location}` : ""}`
        : words.unallocated,
      `${words.status}: ${vars.statut}`,
      ...(meeting.message
        ? [`${words.message}: ${meeting.message.slice(0, 1000)}`]
        : []),
      ...(meeting.cancellationNote ? [`${words.cancellation}: ${meeting.cancellationNote}`] : []),
      ...(vars.instructions_acces ? [`${words.instructions}: ${vars.instructions_acces}`] : []),
      ...(vars.plan_acces ? [`${words.plan}: ${vars.plan_acces}`] : []),
      ...([ctx.config.supportPhone, ctx.config.supportEmail].filter(Boolean)),
    ].join("\n");
  if (type === "OTP")
    body = `${words.code}: ${decryptNetworkingCode(String(payload.encryptedCode), process.env.NETWORKING_TOKEN_SECRET ?? "")}\n${words.expires} ${format(ctx.challenge!.expiresAt)}\n${words.secret}`;
  const template = ctx.config.emailTemplates?.[normalized] ??
    (normalized === eventType ? ctx.config.emailTemplates?.[type] : undefined);
  const substitute = (text: string) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
  const subject = template
    ? substitute(template.subject)
    : `${ctx.event?.name ?? "Focale"} · ${title}`;
  if (template && type !== "OTP") body = substitute(template.body);
  const safe = escapeNetworkingHtml;
  const actionLabels = {
    en: ["Review and accept", "Decline", "Suggest another time"],
    fr: ["Consulter et accepter", "Refuser", "Proposer un autre créneau"],
    ar: ["مراجعة وقبول", "رفض", "اقتراح وقت آخر"],
  }[lang];
  const actions =
    meeting &&
    href &&
    ["MEETING_REQUEST", "MEETING_RESCHEDULE"].includes(normalized) &&
    (meeting.proposalBy
      ? meeting.proposalBy !== ctx.profile?.id
      : meeting.recipientId === ctx.profile?.id)
      ? ["ACCEPT", "DECLINE", "RESCHEDULE"]
          .map(
            (response, index) =>
              `<a href="${safe(`${href}?meetingId=${encodeURIComponent(meeting.id)}&response=${response}`)}" style="display:inline-block;padding:10px 14px;margin:6px;border:1px solid ${safe(ctx.config.primaryColor)};border-radius:6px;color:${safe(ctx.config.primaryColor)}">${safe(actionLabels[index]!)}</a>`,
          )
          .join("")
      : "";

  const logo =
    ctx.config.logoUrl && /^https?:\/\//i.test(ctx.config.logoUrl)
      ? `<img src="${safe(ctx.config.logoUrl)}" width="100" alt="${safe(ctx.event?.name ?? "Focale")}" style="max-height:80px;object-fit:contain" />`
      : "";
  const accessPlan = meeting && vars.plan_acces && /^https?:\/\//i.test(vars.plan_acces)
    ? `<p><a href="${safe(vars.plan_acces)}">${safe(words.plan)}</a></p>` : "";
  const html = `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><body style="margin:0;background:#f3f5f7;font-family:Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:white;border-radius:16px;border-top:4px solid ${safe(ctx.config.primaryColor)}">${logo}<h1 style="font-size:22px">${safe(subject)}</h1><p style="white-space:pre-line;line-height:1.7">${safe(body)}</p>${accessPlan}${actions ? `<p>${actions}</p>` : ""}${href && type !== "OTP" ? `<p><a style="color:${safe(ctx.config.primaryColor)}" href="${safe(href)}">${safe(words.open)}</a></p>` : ""}<p style="font-size:12px;color:#64748b">${safe([ctx.config.supportPhone, ctx.config.supportEmail].filter(Boolean).join(" · "))}</p></main></body></html>`;
  return {
    title,
    subject,
    body,
    html,
    plainText: body + (href && type !== "OTP" ? `\n\n${words.open}: ${href}` : ""),
    href,
    relativeHref,
    attachments: type.startsWith("MEETING_")
      ? networkingMeetingAttachment(ctx)
      : [],
  };
}

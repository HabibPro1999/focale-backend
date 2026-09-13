import { drawNetworkingText } from "./pdf-text";
import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";

export interface NetworkingReportSnapshot {
  summary: Record<string, number>;
  sectors: Array<{
    sector: string;
    participants: number;
    connections: number;
    meetings: number;
  }>;
  timeSeries?: Array<{
    date: string;
    connections: number;
    messages: number;
    meetings: number;
  }>;
}
const text = {
  en: {
    title: "Networking report",
    subtitle: "Activity and outcomes from your event",
    overview: "Event overview",
    participants: "Participants",
    active: "Activated profiles",
    connections: "Mutual connections",
    messages: "Messages",
    meetings: "Planned meetings",
    completed: "Completed meetings",
    rates: "Participation and follow-through",
    activation: "Activation",
    response: "Conversation response",
    attendance: "Recorded attendance",
    activity: "Activity by day",
    sectors: "Connections by sector",
    recommendations: "Observations and next steps",
    noActivity: "No activity was recorded for this period.",
    noAttendance:
      "Meeting attendance was not recorded; completion rates cannot be established.",
    caveat:
      "These metrics describe platform activity. They do not establish revenue, partnerships or participant satisfaction.",
    lowActivation:
      "Invite registered participants to complete their profile before the next event, and explain the value of networking in the welcome email.",
    lowResponse:
      "Encourage a short introduction after each connection. Review profile relevance and notification preferences if conversations receive few replies.",
    noShows:
      "Review reminders, table signage and meeting durations to improve attendance. Confirm that attendance scans were used consistently.",
    good: "Preserve the working event setup and compare the same definitions at the next event. Collect participant feedback before changing the recommendation rules.",
    sector: "Sector",
    count: "Connections",
    generated: "Generated",
    source:
      "Source: event networking records. Daily activity uses the event timezone.",
  },
  fr: {
    title: "Rapport networking",
    subtitle: "Activité et résultats de votre événement",
    overview: "Vue d’ensemble",
    participants: "Participants",
    active: "Profils activés",
    connections: "Connexions mutuelles",
    messages: "Messages",
    meetings: "RDV planifiés",
    completed: "RDV réalisés",
    rates: "Participation et suivi",
    activation: "Activation",
    response: "Réponse aux conversations",
    attendance: "Présence enregistrée",
    activity: "Activité par jour",
    sectors: "Connexions par secteur",
    recommendations: "Observations et prochaines étapes",
    noActivity: "Aucune activité enregistrée sur cette période.",
    noAttendance:
      "La présence aux rendez-vous n’a pas été enregistrée ; le taux de réalisation ne peut pas être établi.",
    caveat:
      "Ces indicateurs décrivent l’activité sur la plateforme. Ils ne prouvent pas un chiffre d’affaires, des partenariats ou la satisfaction des participants.",
    lowActivation:
      "Invitez les inscrits à compléter leur profil avant la prochaine édition et présentez l’intérêt du networking dans l’email de bienvenue.",
    lowResponse:
      "Encouragez une courte présentation après chaque connexion. Vérifiez la pertinence des profils et les préférences de notification si les réponses restent rares.",
    noShows:
      "Revoyez les rappels, la signalétique des tables et la durée des rendez-vous. Vérifiez que les scans de présence ont été utilisés de manière cohérente.",
    good: "Conservez les réglages qui fonctionnent et comparez les mêmes indicateurs à la prochaine édition. Recueillez les retours des participants avant de modifier les recommandations.",
    sector: "Secteur",
    count: "Connexions",
    generated: "Généré le",
    source:
      "Source : données networking de l’événement. Les jours sont calculés dans le fuseau de l’événement.",
  },
  ar: {
    title: "تقرير التواصل المهني",
    subtitle: "نشاط فعاليّتكم ونتائجها",
    overview: "نظرة عامة",
    participants: "المشاركون",
    active: "الملفات المفعّلة",
    connections: "العلاقات المتبادلة",
    messages: "الرسائل",
    meetings: "المواعيد المخطّطة",
    completed: "المواعيد المنجزة",
    rates: "المشاركة والمتابعة",
    activation: "التفعيل",
    response: "الردود على المحادثات",
    attendance: "الحضور المسجّل",
    activity: "النشاط حسب اليوم",
    sectors: "العلاقات حسب القطاع",
    recommendations: "الملاحظات والخطوات التالية",
    noActivity: "لم يُسجّل نشاط خلال هذه الفترة.",
    noAttendance: "لم يُسجّل حضور المواعيد، لذا لا يمكن تحديد معدل إنجازها.",
    caveat:
      "تصف هذه المؤشرات النشاط على المنصة ولا تثبت إيرادات أو شراكات أو رضا المشاركين.",
    lowActivation:
      "ادعُ المسجّلين إلى إكمال ملفاتهم قبل الفعالية المقبلة واشرح قيمة التواصل في رسالة الترحيب.",
    lowResponse:
      "شجّع على تقديم مختصر بعد كل اتصال وراجع ملاءمة الملفات وتفضيلات الإشعارات عند انخفاض الردود.",
    noShows:
      "راجع التذكيرات وإرشادات الطاولات ومدة المواعيد، وتحقّق من استخدام تسجيل الحضور بشكل منتظم.",
    good: "حافظ على الإعدادات الناجحة وقارن المؤشرات نفسها في الفعالية المقبلة. اجمع آراء المشاركين قبل تعديل التوصيات.",
    sector: "القطاع",
    count: "العلاقات",
    generated: "تاريخ الإنشاء",
    source:
      "المصدر: سجلات التواصل للفعالية. يُحسب النشاط اليومي وفق المنطقة الزمنية للفعالية.",
  },
};

export function networkingReportObservations(
  data: NetworkingReportSnapshot,
  language: "fr" | "en" | "ar",
) {
  const words = text[language],
    s = data.summary;
  const observations: string[] = [];
  if (s.participants > 0 && (s.active_participants ?? 0) / s.participants < 0.5)
    observations.push(words.lowActivation);
  if (
    (s.conversations ?? 0) > 0 &&
    (s.responsive_conversations ?? 0) / s.conversations < 0.5
  )
    observations.push(words.lowResponse);
  if ((s.no_shows ?? 0) > 0) observations.push(words.noShows);
  if (!(s.completed_meetings > 0) && !(s.no_shows > 0))
    observations.push(words.noAttendance);
  if (!observations.length) observations.push(words.good);
  return observations;
}

/** Standalone, paginated report with vector charts and source-defined recommendations. */
export async function generateNetworkingPostEventPdf(
  eventName: string,
  data: NetworkingReportSnapshot,
  language: "fr" | "en" | "ar",
  primaryColor = "#166b60",
) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [font, bold] = await Promise.all(
    ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map(async (name) =>
      doc.embedFont(
        await readFile(require.resolve(`dejavu-fonts-ttf/ttf/${name}`)),
        { subset: true },
      ),
    ),
  );
  const words = text[language],
    rtl = language === "ar";
  const hex = /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#166b60";
  const accent = rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  );
  const ink = rgb(0.1, 0.14, 0.17),
    muted = rgb(0.38, 0.43, 0.47),
    pale = rgb(0.95, 0.96, 0.96);
  let page: PDFPage = doc.addPage([595.28, 841.89]);
  let y = 0;
  const write = (
    value: string,
    x: number,
    baseline: number,
    size = 10,
    strong = false,
    width = 505,
  ) => {
    const face = strong ? bold : font;
    drawNetworkingText(page,value,{
      x,y:baseline,font:face,size,color:ink,width,
      direction:rtl?"rtl":"ltr",align:rtl?"right":"left",
    });
  };
  const startPage = () => {
    page.drawRectangle({
      x: 0,
      y: 828,
      width: 595.28,
      height: 14,
      color: accent,
    });
    y = 785;
    write("FOCALE / NETWORKING", 45, 805, 8, true);
  };
  const newPage = () => {
    page = doc.addPage([595.28, 841.89]);
    startPage();
  };
  const ensure = (height: number) => {
    if (y - height < 60) newPage();
  };
  const paragraph = (value: string, size = 10) => {
    const words = value.split(/\s+/);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > 505 && line) {
        ensure(size + 6);
        write(line, 45, y, size);
        y -= size + 6;
        line = word;
      } else line = next;
    }
    if (line) {
      ensure(size + 6);
      write(line, 45, y, size);
      y -= size + 6;
    }
  };
  const heading = (value: string) => {
    ensure(64);
    y -= 12;
    write(value, 45, y, 15, true);
    y -= 27;
  };
  startPage();
  paragraph(words.title, 24);
  paragraph(eventName, 15);
  paragraph(words.subtitle, 10);
  y -= 8;
  paragraph(
    `${words.generated}: ${new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(new Date())}`,
    9,
  );
  heading(words.overview);
  const metrics = [
    [words.participants, data.summary.participants],
    [words.active, data.summary.active_participants],
    [words.connections, data.summary.connections],
    [words.messages, data.summary.messages],
    [words.meetings, data.summary.meetings],
    [words.completed, data.summary.completed_meetings],
  ] as const;
  for (let row = 0; row < 2; row++) {
    ensure(88);
    for (let col = 0; col < 3; col++) {
      const [label, value] = metrics[row * 3 + col]!;
      const x = 45 + col * 172;
      page.drawRectangle({ x, y: y - 72, width: 160, height: 79, color: pale });
      write(String(value ?? 0), x + 12, y - 30, 24, true, 136);
      write(label, x + 12, y - 54, 8, false, 136);
    }
    y -= 92;
  }
  heading(words.rates);
  const s = data.summary;
  const rates = [
    [
      words.activation,
      s.participants ? (s.active_participants ?? 0) / s.participants : 0,
    ],
    [
      words.response,
      s.conversations ? (s.responsive_conversations ?? 0) / s.conversations : 0,
    ],
  ] as const;
  for (const [label, rate] of rates) {
    ensure(43);
    write(label, 45, y, 10);
    page.drawRectangle({
      x: 45,
      y: y - 18,
      width: 425,
      height: 8,
      color: pale,
    });
    page.drawRectangle({
      x: 45,
      y: y - 18,
      width: 425 * Math.max(0, Math.min(1, rate)),
      height: 8,
      color: accent,
    });
    write(
      new Intl.NumberFormat(language, {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(rate),
      482,
      y - 19,
      10,
      true,
      68,
    );
    y -= 43;
  }
  heading(words.activity);
  const series = data.timeSeries ?? [];
  if (!series.length) paragraph(words.noActivity);
  else {
    const max = Math.max(1, ...series.map((row) => row.connections));
    for (const row of series) {
      ensure(31);
      write(row.date, 45, y, 8, false, 80);
      page.drawRectangle({
        x: 135,
        y: y - 2,
        width: (330 * row.connections) / max,
        height: 9,
        color: accent,
      });
      write(String(row.connections), 480, y, 9, true, 60);
      y -= 23;
    }
    paragraph(words.connections, 8);
  }
  newPage();
  heading(words.sectors);
  if (!data.sectors.length) paragraph(words.noActivity);
  const maxSector = Math.max(
    1,
    ...data.sectors.map((sector) => sector.connections),
  );
  for (const sector of data.sectors) {
    ensure(52);
    paragraph(
      `${sector.sector || "—"}: ${sector.connections} ${words.count.toLowerCase()}`,
      10,
    );
    page.drawRectangle({
      x: 45,
      y: y - 6,
      width: (505 * sector.connections) / maxSector,
      height: 7,
      color: accent,
    });
    y -= 23;
  }
  heading(words.recommendations);
  for (const [index, observation] of networkingReportObservations(
    data,
    language,
  ).entries()) {
    paragraph(`${index + 1}. ${observation}`);
    y -= 10;
  }
  y -= 8;
  paragraph(words.caveat, 9);
  y -= 6;
  paragraph(words.source, 8);
  for (const [index, current] of doc.getPages().entries()) {
    current.drawLine({
      start: { x: 45, y: 43 },
      end: { x: 550, y: 43 },
      thickness: 0.5,
      color: muted,
    });
    current.drawText(`${index + 1} / ${doc.getPageCount()}`, {
      x: 510,
      y: 27,
      font,
      size: 8,
      color: muted,
    });
  }
  return Buffer.from(await doc.save());
}

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  clients,
  users,
  events,
  forms,
  registrations,
  networkingConfigs,
  networkingProfiles,
  getDb,
  syncNetworkingRegistration,
} from "../src";
import { NetworkingConfigSchema } from "@app/contracts";
import { eq } from "drizzle-orm";
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.includes("networking_test_")
  )
    throw new Error(
      "Only isolated local networking test databases can be seeded",
    );
  const db = getDb(),
    slug = "networking-demo";
  if ((await db.select().from(events).where(eq(events.slug, slug))).length)
    throw new Error("Reuse the existing demo; do not overwrite it");
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "organizer@networking.example.test",
        password: "Networking-demo-2026!",
        returnSecureToken: true,
      }),
    },
  );
  const account = (await response.json()) as { localId?: string };
  if (!account.localId)
    throw new Error("Could not create local emulator account");
  const clientId = randomUUID(),
    eventId = randomUUID(),
    formId = randomUUID();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await db
    .insert(clients)
    .values({
      id: clientId,
      name: "Focale Networking QA",
      enabledModules: [
        "registrations",
        "emails",
        "networking",
        "pricing",
        "sponsorships",
        "certificates",
        "abstracts",
      ],
    });
  await db
    .insert(users)
    .values({
      id: account.localId,
      email: "organizer@networking.example.test",
      name: "Networking Organizer",
      role: 0,
      clientId: null,
    });
  await db
    .insert(events)
    .values({
      id: eventId,
      clientId,
      name: "Focale Business Connections",
      slug,
      startDate: new Date(Date.now() - 86_400_000),
      endDate: new Date(`${tomorrow}T19:00:00Z`),
      status: "OPEN",
      location: "Tunis Convention Centre",
    });
  const fields = [
    ["first", "firstName", "Prénom"],
    ["last", "lastName", "Nom"],
    ["email", "email", "Email"],
    ["company", "text", "Entreprise"],
    ["role", "text", "Fonction"],
    ["sector", "text", "Secteur"],
    ["offer", "textarea", "Je propose"],
    ["need", "textarea", "Je recherche"],
  ].map(([id, type, label]) => ({
    id,
    type,
    label,
    required: !["offer", "need"].includes(id!),
  }));
  await db
    .insert(forms)
    .values({
      id: formId,
      eventId,
      type: "REGISTRATION",
      name: "Registration",
      schema: {
        steps: [{ id: "identity", title: "Votre profil", fields }],
        settings: { languages: ["fr", "en", "ar"] },
      },
    });
  await db
    .insert(networkingConfigs)
    .values({
      eventId,
      config: NetworkingConfigSchema.parse({
        enabled: true,
        approvalMode: "AUTOMATIC",
        eligiblePaymentStatuses: ["PAID", "WAIVED", "SPONSORED"],
        timezone: "UTC",
        openingHours: [{ date: tomorrow, start: "09:00", end: "18:00" }],
        fieldMapping: {
          company: "company",
          jobTitle: "role",
          sector: "sector",
          offers: "offer",
          seeks: "need",
        },
        welcomeMessage: "Des rencontres qui font avancer vos projets.",
        primaryColor: "#166b60",
        supportEmail: "support@example.test",
      }),
    });
  const people = [
    [
      "Amel",
      "Ben Salah",
      "amel@example.test",
      "MedVision",
      "Fondatrice",
      "Santé",
      "Sites pilotes cliniques",
      "Investisseurs pour une levée de fonds",
      "fr",
    ],
    [
      "Karim",
      "Mansour",
      "karim@example.test",
      "Carthage Ventures",
      "Investisseur",
      "Investissement",
      "Capital pour startups de la santé",
      "Startups médicales",
      "fr",
    ],
    [
      "Leila",
      "Haddad",
      "leila@example.test",
      "Green Horizons",
      "Directrice",
      "Énergie",
      "Solutions solaires",
      "Partenaires industriels",
      "en",
    ],
    [
      "Sami",
      "Trabelsi",
      "sami@example.test",
      "Atlas Industries",
      "Directeur",
      "Industrie",
      "Distribution industrielle",
      "Solutions énergétiques durables",
      "ar",
    ],
  ];
  const participants = [];
  for (const [
    firstName,
    lastName,
    email,
    company,
    role,
    sector,
    offer,
    need,
    language,
  ] of people) {
    const registrationId = randomUUID();
    await db
      .insert(registrations)
      .values({
        id: registrationId,
        eventId,
        formId,
        email: email!,
        firstName,
        lastName,
        formData: {
          first: firstName,
          last: lastName,
          email,
          company,
          role,
          sector,
          offer,
          need,
        },
        networkingOptIn: true,
        paymentStatus: "PAID",
        totalAmount: 0,
        priceBreakdown: {},
      });
    await syncNetworkingRegistration(registrationId);
    const [profile] = await db
      .select()
      .from(networkingProfiles)
      .where(eq(networkingProfiles.registrationId, registrationId));
    await db
      .update(networkingProfiles)
      .set({ language: language as "fr" | "en" | "ar" })
      .where(eq(networkingProfiles.id, profile!.id));
    participants.push({ profileId: profile!.id, email });
  }
  await writeFile(
    "/tmp/focale-networking-qa/fixture.json",
    JSON.stringify(
      {
        clientId,
        eventId,
        formId,
        slug,
        tomorrow,
        adminUid: account.localId,
        participants,
      },
      null,
      2,
    ),
  );
  console.log(
    "Seeded local demo; fixture IDs saved to /tmp/focale-networking-qa/fixture.json",
  );
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/client";
import { clients } from "../../src/schema/users-clients";
import { events } from "../../src/schema/events-access";
import { forms } from "../../src/schema/forms";
import { registrations } from "../../src/schema/registrations";
import {
  networkingConfigs,
  networkingProfiles,
  networkingSessions,
  networkingBlocks,
  networkingInterests,
  networkingConnections,
} from "../../src/schema/networking";
import { NetworkingConfigSchema } from "@app/contracts";

/** Isolated disposable fixture; never touches networking-demo or shared fixture IDs. */
export async function createNetworkingScaleFixture(
  size: number,
  hash: (token: string) => string,
) {
  const db = getDb();
  const id = randomUUID(),
    clientId = randomUUID(),
    formId = randomUUID();
  const timestamp = new Date();
  const startDate = new Date(Date.now() + 86_400_000),
    endDate = new Date(Date.now() + 2 * 86_400_000);
  await db
    .insert(clients)
    .values({
      id: clientId,
      name: `Networking scale ${id}`,
      enabledModules: ["networking", "registrations", "emails"],
    });
  const [event] = await db
    .insert(events)
    .values({
      id,
      clientId,
      name: `Synthetic ${size}`,
      slug: `networking-scale-${id}`,
      status: "OPEN",
      startDate,
      endDate,
    })
    .returning();
  const config = NetworkingConfigSchema.parse({
    enabled: true,
    approvalMode: "AUTOMATIC",
    meetingsEnabled: false,
  });
  await db.insert(networkingConfigs).values({ eventId: id, config });
  await db
    .insert(forms)
    .values({
      id: formId,
      eventId: id,
      name: "Synthetic registration",
      schema: { steps: [] },
    });
  const pairs = Array.from({ length: size }, (_, i) => ({
    index: i,
    profileId: randomUUID(),
    registrationId: randomUUID(),
  }));
  for (let start = 0; start < size; start += 200) {
    const batch = pairs.slice(start, start + 200);
    await db
      .insert(registrations)
      .values(
        batch.map((p) => ({
          id: p.registrationId,
          eventId: id,
          formId,
          email: `${p.profileId}@example.invalid`,
          firstName: `Participant${p.index}`,
          lastName: "Scale",
          paymentStatus:
            p.index > 0 && p.index % 10 === 0
              ? ("PENDING" as const)
              : ("PAID" as const),
          networkingOptIn: p.index === 0 || p.index % 17 !== 0,
          totalAmount: 0,
          priceBreakdown: {} as never,
          formData: {
            company: `Company ${p.index % 100}`,
            role: "Business development",
            answers: "Synthetic registration field answer. ".repeat(40),
          },
        })),
      );
    await db
      .insert(networkingProfiles)
      .values(
        batch.map((p) => ({
          id: p.profileId,
          eventId: id,
          registrationId: p.registrationId,
          email: `${p.profileId}@example.invalid`,
          firstName:
            p.index % 23 === 0
              ? "Mohamed"
              : `Participant${String(p.index).padStart(5, "0")}`,
          lastName: "Scale",
          company: `Company ${p.index % 100}`,
          jobTitle: "Business development",
          sector: p.index % 2 === 0 ? "Finance" : "Health",
          city: p.index % 3 === 0 ? "Tunis" : "Sfax",
          country: "Tunisia",
          bio: "Professional seeking partnerships across the region.",
          offers:
            "Market access, distribution services and commercial expertise.",
          seeks: "Investment and sustainable commercial partnerships.",
          interests: ["Investment", "Partnerships"],
          status:
            p.index > 0 && p.index % 31 === 0
              ? ("SUSPENDED" as const)
              : ("ACTIVE" as const),
          visible: p.index === 0 || p.index % 19 !== 0,
          consent: p.index === 0 || p.index % 29 !== 0,
          lastActiveAt: timestamp,
        })),
      );
  }
  const actorId = pairs[0].profileId;
  const exclusions = pairs.slice(1, 101);
  await db
    .insert(networkingBlocks)
    .values(
      exclusions
        .slice(0, 30)
        .map((p, i) => ({
          eventId: id,
          profileId: i % 2 === 0 ? actorId : p.profileId,
          targetId: i % 2 === 0 ? p.profileId : actorId,
        })),
    );
  await db
    .insert(networkingInterests)
    .values(
      exclusions
        .slice(30, 75)
        .map((p) => ({
          eventId: id,
          profileId: actorId,
          targetId: p.profileId,
          action: "PASS" as const,
        })),
    );
  await db
    .insert(networkingConnections)
    .values(
      exclusions
        .slice(75, 100)
        .map((p) => ({
          eventId: id,
          profileAId: [actorId, p.profileId].sort()[0],
          profileBId: [actorId, p.profileId].sort()[1],
        })),
    );
  const token = randomBytes(48).toString("base64url");
  await db
    .insert(networkingSessions)
    .values({
      eventId: id,
      profileId: actorId,
      tokenHash: hash(token),
      expiresAt: endDate,
    });
  return {
    event,
    config,
    pairs,
    actorId,
    token,
    async cleanup() {
      await db.delete(registrations).where(eq(registrations.eventId, id));
      await db.delete(forms).where(eq(forms.id, formId));
      await db.delete(events).where(eq(events.id, id));
      await db.delete(clients).where(eq(clients.id, clientId));
    },
  };
}

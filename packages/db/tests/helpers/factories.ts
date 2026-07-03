import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@app/shared";
import {
  getDb,
  abstractConfig,
  abstracts,
  clients,
  eventAccess,
  events,
  forms,
  registrations,
  sponsorshipBatches,
  sponsorshipUsages,
  sponsorships,
  users,
} from "@app/db";

// Minimal insert factories for the real-DB tiers. Only the columns the ported
// tests need are set; everything else rides the schema defaults. IDs are omitted
// where the column self-defaults (idPk / UUIDv7); users.id is app-supplied
// (Firebase UID) so it is provided.

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

export async function seedClient(
  overrides: Partial<typeof clients.$inferInsert> = {},
): Promise<Row<typeof clients>> {
  const [row] = await getDb()
    .insert(clients)
    .values({ name: "Test Client", email: "client@example.test", ...overrides })
    .returning();
  return row;
}

export async function seedUser(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<Row<typeof users>> {
  const [row] = await getDb()
    .insert(users)
    .values({
      id: newId(),
      email: `user-${randomUUID()}@example.test`,
      name: "Test Reviewer",
      role: 1,
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedEvent(
  overrides: Partial<typeof events.$inferInsert> = {},
): Promise<Row<typeof events>> {
  const clientId = overrides.clientId ?? (await seedClient()).id;
  const [row] = await getDb()
    .insert(events)
    .values({
      clientId,
      name: "Test Event",
      slug: `test-event-${randomUUID()}`,
      status: "OPEN",
      startDate: new Date("2030-01-01T09:00:00.000Z"),
      endDate: new Date("2030-01-02T17:00:00.000Z"),
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedEventAccess(
  overrides: Partial<typeof eventAccess.$inferInsert> = {},
): Promise<Row<typeof eventAccess>> {
  const eventId = overrides.eventId ?? (await seedEvent()).id;
  const [row] = await getDb()
    .insert(eventAccess)
    .values({ eventId, name: "Test Access", ...overrides })
    .returning();
  return row;
}

export async function seedForm(
  overrides: Partial<typeof forms.$inferInsert> = {},
): Promise<Row<typeof forms>> {
  const eventId = overrides.eventId ?? (await seedEvent()).id;
  const [row] = await getDb()
    .insert(forms)
    .values({ eventId, name: "Test Form", schema: { fields: [] }, ...overrides })
    .returning();
  return row;
}

export async function seedRegistration(
  overrides: Partial<typeof registrations.$inferInsert> = {},
): Promise<Row<typeof registrations>> {
  let formId = overrides.formId;
  let eventId = overrides.eventId;
  if (!formId) {
    const form = await seedForm(eventId ? { eventId } : {});
    formId = form.id;
    eventId = form.eventId;
  } else if (!eventId) {
    const [f] = await getDb().select().from(forms).where(eq(forms.id, formId));
    eventId = f.eventId;
  }
  const [row] = await getDb()
    .insert(registrations)
    .values({
      formId,
      eventId: eventId!,
      formData: {},
      email: `registrant-${randomUUID()}@example.test`,
      firstName: "Test",
      lastName: "Registrant",
      totalAmount: 0,
      priceBreakdown: {},
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedSponsorshipBatch(
  overrides: Partial<typeof sponsorshipBatches.$inferInsert> & {
    eventId: string;
    formId: string;
  },
): Promise<Row<typeof sponsorshipBatches>> {
  const [row] = await getDb()
    .insert(sponsorshipBatches)
    .values({
      labName: "Test Lab",
      contactName: "Contact",
      email: "lab@example.test",
      formData: {},
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedSponsorship(
  overrides: Partial<typeof sponsorships.$inferInsert> & {
    batchId: string;
    eventId: string;
  },
): Promise<Row<typeof sponsorships>> {
  const [row] = await getDb()
    .insert(sponsorships)
    .values({
      code: `SPON-${randomUUID().slice(0, 8)}`,
      beneficiaryName: "Beneficiary",
      beneficiaryEmail: "ben@example.test",
      totalAmount: 0,
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedSponsorshipUsage(
  values: typeof sponsorshipUsages.$inferInsert,
): Promise<Row<typeof sponsorshipUsages>> {
  const [row] = await getDb().insert(sponsorshipUsages).values(values).returning();
  return row;
}

export async function seedAbstractConfig(
  overrides: Partial<typeof abstractConfig.$inferInsert> & { eventId: string },
): Promise<Row<typeof abstractConfig>> {
  const [row] = await getDb()
    .insert(abstractConfig)
    .values(overrides)
    .returning();
  return row;
}

export async function seedAbstract(
  overrides: Partial<typeof abstracts.$inferInsert> & { eventId: string },
): Promise<Row<typeof abstracts>> {
  const [row] = await getDb()
    .insert(abstracts)
    .values({
      authorFirstName: "Author",
      authorLastName: "Test",
      authorEmail: `author-${randomUUID()}@example.test`,
      authorPhone: "+21600000000",
      requestedType: "ORAL_COMMUNICATION",
      content: {},
      editToken: newId(),
      ...overrides,
    })
    .returning();
  return row;
}

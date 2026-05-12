import { randomUUID } from "crypto";
import { AccessType, EventStatus, FormType } from "@/generated/prisma/enums.js";
import { prisma } from "./db.js";

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export async function seedClient(
  overrides: Parameters<typeof prisma.client.create>[0]["data"] = {},
) {
  return prisma.client.create({
    data: {
      name: "Test Client",
      email: "client@example.test",
      ...overrides,
    },
  });
}

export async function seedEvent(
  overrides: Partial<Parameters<typeof prisma.event.create>[0]["data"]> = {},
) {
  const clientId =
    typeof overrides.clientId === "string"
      ? overrides.clientId
      : (await seedClient()).id;

  return prisma.event.create({
    data: {
      clientId,
      name: "Test Event",
      slug: uniqueSlug("test-event"),
      status: EventStatus.OPEN,
      startDate: new Date("2030-01-01T09:00:00.000Z"),
      endDate: new Date("2030-01-02T17:00:00.000Z"),
      ...overrides,
    },
  });
}

export async function seedForm(
  overrides: Partial<Parameters<typeof prisma.form.create>[0]["data"]> = {},
) {
  const eventId =
    typeof overrides.eventId === "string"
      ? overrides.eventId
      : (await seedEvent()).id;

  return prisma.form.create({
    data: {
      eventId,
      type: FormType.REGISTRATION,
      name: "Test Registration Form",
      schema: { fields: [] },
      active: true,
      ...overrides,
    },
  });
}

export async function seedPricing(
  overrides: Partial<Parameters<typeof prisma.eventPricing.create>[0]["data"]> = {},
) {
  const eventId =
    typeof overrides.eventId === "string"
      ? overrides.eventId
      : (await seedEvent()).id;

  return prisma.eventPricing.create({
    data: {
      eventId,
      basePrice: 0,
      currency: "TND",
      rules: [],
      ...overrides,
    },
  });
}

export async function seedAccess(
  overrides: Partial<Parameters<typeof prisma.eventAccess.create>[0]["data"]> = {},
) {
  const eventId =
    typeof overrides.eventId === "string"
      ? overrides.eventId
      : (await seedEvent()).id;

  return prisma.eventAccess.create({
    data: {
      eventId,
      type: AccessType.OTHER,
      name: "Test Access",
      price: 0,
      currency: "TND",
      active: true,
      ...overrides,
    },
  });
}

export async function seedRegistration(
  overrides: Partial<Parameters<typeof prisma.registration.create>[0]["data"]> = {},
) {
  const formId =
    typeof overrides.formId === "string"
      ? overrides.formId
      : (await seedForm()).id;
  const form = await prisma.form.findUniqueOrThrow({ where: { id: formId } });

  return prisma.registration.create({
    data: {
      formId,
      eventId: form.eventId,
      formData: {},
      email: `registrant-${randomUUID()}@example.test`,
      firstName: "Test",
      lastName: "Registrant",
      totalAmount: 0,
      priceBreakdown: {},
      ...overrides,
    },
  });
}

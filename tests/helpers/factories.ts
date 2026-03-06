import { faker } from "@faker-js/faker";
import type {
  Client,
  User,
  Event,
  EventPricing,
  EventAccess,
  Form,
  Registration,
  Sponsorship,
  SponsorshipBatch,
} from "@/generated/prisma/client.js";

// ============================================================================
// Client Factory
// ============================================================================

export function createMockClient(overrides: Partial<Client> = {}): Client {
  const name = overrides.name ?? faker.company.name();
  return {
    id: faker.string.uuid(),
    name,
    email: faker.internet.email(),
    phone: faker.phone.number(),
    active: true,
    enabledModules: ["pricing", "registrations", "sponsorships", "emails"],
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// User Factory
// ============================================================================

export const UserRole = {
  SUPER_ADMIN: 0,
  CLIENT_ADMIN: 1,
} as const;

export function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: faker.string.uuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    role: UserRole.CLIENT_ADMIN,
    clientId: faker.string.uuid(),
    active: true,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function createMockSuperAdmin(overrides: Partial<User> = {}): User {
  return createMockUser({
    role: UserRole.SUPER_ADMIN,
    clientId: null,
    ...overrides,
  });
}

export function createMockClientAdmin(
  clientId: string,
  overrides: Partial<User> = {},
): User {
  return createMockUser({
    role: UserRole.CLIENT_ADMIN,
    clientId,
    ...overrides,
  });
}

// ============================================================================
// Event Factory
// ============================================================================

export function createMockEvent(overrides: Partial<Event> = {}): Event {
  const name = overrides.name ?? faker.lorem.words(3);
  const startDate = overrides.startDate ?? faker.date.future();
  return {
    id: faker.string.uuid(),
    clientId: faker.string.uuid(),
    name,
    slug: faker.helpers.slugify(name).toLowerCase(),
    description: faker.lorem.paragraph(),
    startDate,
    endDate: faker.date.future({ refDate: startDate }),
    location: faker.location.city(),
    maxCapacity: faker.number.int({ min: 50, max: 500 }),
    registeredCount: 0,
    status: "CLOSED",
    bannerUrl: null,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Event Pricing Factory
// ============================================================================

export function createMockEventPricing(
  overrides: Partial<EventPricing> = {},
): EventPricing {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    basePrice: faker.number.int({ min: 100, max: 1000 }),
    currency: "TND",
    rules: [],
    onlinePaymentEnabled: false,
    onlinePaymentUrl: null,
    bankName: "Test Bank",
    bankAccountName: "Test Account",
    bankAccountNumber: faker.finance.accountNumber(),
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Event Access Factory
// ============================================================================

export function createMockEventAccess(
  overrides: Partial<EventAccess> = {},
): EventAccess {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    name: faker.lorem.words(2),
    description: faker.lorem.sentence(),
    location: null,
    type: "WORKSHOP",
    price: faker.number.int({ min: 50, max: 200 }),
    currency: "TND",
    maxCapacity: faker.number.int({ min: 20, max: 100 }),
    registeredCount: 0,
    startsAt: null,
    endsAt: null,
    availableFrom: null,
    availableTo: null,
    conditions: [],
    conditionLogic: "and",
    sortOrder: 0,
    groupLabel: null,
    allowCompanion: false,
    active: true,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Form Factory
// ============================================================================

export function createMockForm(overrides: Partial<Form> = {}): Form {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    type: "REGISTRATION",
    name: "Registration Form",
    schema: {
      steps: [
        {
          id: "step-1",
          title: "Personal Information",
          fields: [
            {
              id: "firstName",
              type: "text",
              label: "First Name",
              required: true,
            },
            {
              id: "lastName",
              type: "text",
              label: "Last Name",
              required: true,
            },
            { id: "email", type: "email", label: "Email", required: true },
          ],
        },
      ],
    },
    schemaVersion: 1,
    successTitle: null,
    successMessage: null,
    active: true,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Registration Factory
// ============================================================================

export function createMockRegistration(
  overrides: Partial<Registration> = {},
): Registration {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    formId: faker.string.uuid(),
    formData: {
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
    },
    formSchemaVersion: 1,
    email: faker.internet.email(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    phone: faker.phone.number(),
    paymentStatus: "PENDING",
    paymentMethod: null,
    paymentReference: null,
    totalAmount: faker.number.int({ min: 100, max: 1000 }),
    paidAmount: 0,
    currency: "TND",
    priceBreakdown: {
      basePrice: 300,
      appliedRules: [],
      calculatedBasePrice: 300,
      accessItems: [],
      accessTotal: 0,
      subtotal: 300,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: 300,
      currency: "TND",
    },
    baseAmount: 300,
    discountAmount: 0,
    accessAmount: 0,
    paymentProofUrl: null,
    sponsorshipCode: null,
    sponsorshipAmount: 0,
    paidAt: null,
    submittedAt: faker.date.past(),
    lastEditedAt: null,
    editToken: null,
    editTokenExpiry: null,
    idempotencyKey: null,
    linkBaseUrl: null,
    note: null,
    accessTypeIds: [],
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Sponsorship Batch Factory
// ============================================================================

export function createMockSponsorshipBatch(
  overrides: Partial<SponsorshipBatch> = {},
): SponsorshipBatch {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    formId: faker.string.uuid(),
    labName: faker.company.name(),
    contactName: faker.person.fullName(),
    email: faker.internet.email(),
    phone: faker.phone.number(),
    formData: {},
    createdAt: faker.date.past(),
    ...overrides,
  };
}

// ============================================================================
// Sponsorship Factory
// ============================================================================

export function createMockSponsorship(
  overrides: Partial<Sponsorship> = {},
): Sponsorship {
  return {
    id: faker.string.uuid(),
    eventId: faker.string.uuid(),
    batchId: faker.string.uuid(),
    code: faker.string.alphanumeric(8).toUpperCase(),
    status: "PENDING",
    beneficiaryName: faker.person.fullName(),
    beneficiaryEmail: faker.internet.email(),
    beneficiaryPhone: faker.phone.number(),
    beneficiaryAddress: null,
    coversBasePrice: true,
    coveredAccessIds: [],
    totalAmount: faker.number.int({ min: 100, max: 500 }),
    nominalAmount: 0,
    targetRegistrationId: null,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Utility: Create multiple mocks
// ============================================================================

export function createManyMockClients(count: number): Client[] {
  return faker.helpers.multiple(() => createMockClient(), { count });
}

export function createManyMockEvents(count: number): Event[] {
  return faker.helpers.multiple(() => createMockEvent(), { count });
}

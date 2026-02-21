import { describe, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  getRegistrationTableColumns,
  listRegistrationAuditLogs,
  listRegistrationEmailLogs,
  searchRegistrantsForSponsorship,
} from "./registration-query.service.js";

// ============================================================================
// getRegistrationTableColumns
// ============================================================================

describe("getRegistrationTableColumns", () => {
  const eventId = faker.string.uuid();

  it("returns only fixed columns when no form exists for event", async () => {
    prismaMock.form.findFirst.mockResolvedValue(null);

    const result = await getRegistrationTableColumns(eventId);

    expect(result.formColumns).toHaveLength(0);
    expect(result.fixedColumns).toHaveLength(7);
    expect(result.fixedColumns.map((c) => c.id)).toEqual([
      "email",
      "firstName",
      "lastName",
      "phone",
      "paymentStatus",
      "totalAmount",
      "createdAt",
    ]);
  });

  it("returns only fixed columns when form has no schema", async () => {
    prismaMock.form.findFirst.mockResolvedValue({ schema: null } as never);

    const result = await getRegistrationTableColumns(eventId);

    expect(result.formColumns).toHaveLength(0);
    expect(result.fixedColumns).toHaveLength(7);
  });

  it("extracts form columns from schema steps", async () => {
    const formSchema = {
      steps: [
        {
          fields: [
            { id: "email-1", type: "email", label: "Email Address" },
            { id: "name-1", type: "text", label: "First Name" },
            { id: "name-2", type: "text", label: "Last Name" },
            { id: "phone-1", type: "phone", label: "Phone Number" },
          ],
        },
        {
          fields: [
            { id: "specialty-1", type: "text", label: "Specialty" },
            { id: "country-1", type: "select", label: "Country" },
          ],
        },
      ],
    };

    prismaMock.form.findFirst.mockResolvedValue({
      schema: formSchema,
    } as never);

    const result = await getRegistrationTableColumns(eventId);

    // Step 2 fields show as formColumns
    expect(result.formColumns.map((c) => c.id)).toContain("specialty-1");
    expect(result.formColumns.map((c) => c.id)).toContain("country-1");

    // Contact fields from step 1 drive fixed column labels
    expect(result.fixedColumns.find((c) => c.id === "email")?.label).toBe(
      "Email Address",
    );
    expect(result.fixedColumns.find((c) => c.id === "firstName")?.label).toBe(
      "First Name",
    );
    expect(result.fixedColumns.find((c) => c.id === "lastName")?.label).toBe(
      "Last Name",
    );
    expect(result.fixedColumns.find((c) => c.id === "phone")?.label).toBe(
      "Phone Number",
    );
  });

  it("excludes heading and paragraph fields from formColumns", async () => {
    const formSchema = {
      steps: [
        {
          fields: [
            { id: "email-1", type: "email", label: "Email" },
            { id: "name-1", type: "text", label: "Name" },
            { id: "name-2", type: "text", label: "Surname" },
            { id: "phone-1", type: "phone", label: "Phone" },
          ],
        },
        {
          fields: [
            { id: "heading-1", type: "heading", label: "Section Header" },
            { id: "para-1", type: "paragraph", label: "Info text" },
            { id: "specialty-1", type: "text", label: "Specialty" },
          ],
        },
      ],
    };

    prismaMock.form.findFirst.mockResolvedValue({
      schema: formSchema,
    } as never);

    const result = await getRegistrationTableColumns(eventId);

    expect(result.formColumns.map((c) => c.id)).not.toContain("heading-1");
    expect(result.formColumns.map((c) => c.id)).not.toContain("para-1");
    expect(result.formColumns.map((c) => c.id)).toContain("specialty-1");
  });

  it("uses default labels when form has no matching field types", async () => {
    const formSchema = {
      steps: [
        {
          // No email, text, or phone fields in step 1
          fields: [{ id: "select-1", type: "select", label: "Category" }],
        },
      ],
    };

    prismaMock.form.findFirst.mockResolvedValue({
      schema: formSchema,
    } as never);

    const result = await getRegistrationTableColumns(eventId);

    expect(result.fixedColumns.find((c) => c.id === "email")?.label).toBe(
      "Email",
    );
    expect(result.fixedColumns.find((c) => c.id === "firstName")?.label).toBe(
      "First Name",
    );
    expect(result.fixedColumns.find((c) => c.id === "lastName")?.label).toBe(
      "Last Name",
    );
    expect(result.fixedColumns.find((c) => c.id === "phone")?.label).toBe(
      "Phone",
    );
  });

  it("always includes paymentStatus, totalAmount, createdAt as fixed columns", async () => {
    prismaMock.form.findFirst.mockResolvedValue(null);

    const result = await getRegistrationTableColumns(eventId);

    const ids = result.fixedColumns.map((c) => c.id);
    expect(ids).toContain("paymentStatus");
    expect(ids).toContain("totalAmount");
    expect(ids).toContain("createdAt");
  });
});

// ============================================================================
// listRegistrationAuditLogs
// ============================================================================

describe("listRegistrationAuditLogs", () => {
  const registrationId = faker.string.uuid();

  it("returns paginated audit logs with SYSTEM performer name", async () => {
    const mockLog = {
      id: faker.string.uuid(),
      entityType: "Registration",
      entityId: registrationId,
      action: "CREATE",
      changes: null,
      performedBy: "SYSTEM",
      performedAt: new Date("2024-01-01T10:00:00Z"),
      ipAddress: null,
    };

    prismaMock.auditLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.auditLog.count.mockResolvedValue(1);

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].action).toBe("CREATE");
    expect(result.data[0].performedByName).toBe("System");
    expect(result.meta.total).toBe(1);
    expect(result.meta.page).toBe(1);
  });

  it("resolves PUBLIC performer to registrant label", async () => {
    const mockLog = {
      id: faker.string.uuid(),
      entityType: "Registration",
      entityId: registrationId,
      action: "UPDATE",
      changes: null,
      performedBy: "PUBLIC",
      performedAt: new Date(),
      ipAddress: null,
    };

    prismaMock.auditLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.auditLog.count.mockResolvedValue(1);

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data[0].performedByName).toBe("Registrant (Self-Edit)");
  });

  it("resolves user IDs to names", async () => {
    const userId = faker.string.uuid();
    const mockLog = {
      id: faker.string.uuid(),
      entityType: "Registration",
      entityId: registrationId,
      action: "UPDATE",
      changes: null,
      performedBy: userId,
      performedAt: new Date(),
      ipAddress: null,
    };

    prismaMock.auditLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.auditLog.count.mockResolvedValue(1);
    prismaMock.user.findMany.mockResolvedValue([
      { id: userId, name: "Admin User" } as never,
    ]);

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data[0].performedByName).toBe("Admin User");
  });

  it("returns null for unknown user IDs not in the database", async () => {
    const unknownUserId = faker.string.uuid();
    const mockLog = {
      id: faker.string.uuid(),
      entityType: "Registration",
      entityId: registrationId,
      action: "UPDATE",
      changes: null,
      performedBy: unknownUserId,
      performedAt: new Date(),
      ipAddress: null,
    };

    prismaMock.auditLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.auditLog.count.mockResolvedValue(1);
    prismaMock.user.findMany.mockResolvedValue([]); // User not found

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data[0].performedByName).toBeNull();
  });

  it("returns empty page with correct meta when no logs exist", async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(0);

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
    expect(result.meta.totalPages).toBe(0);
  });

  it("paginates correctly on second page", async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(55);

    const result = await listRegistrationAuditLogs(registrationId, {
      page: 2,
      limit: 50,
    });

    expect(result.meta.page).toBe(2);
    expect(result.meta.total).toBe(55);
    expect(result.meta.totalPages).toBe(2);
  });
});

// ============================================================================
// listRegistrationEmailLogs
// ============================================================================

describe("listRegistrationEmailLogs", () => {
  const registrationId = faker.string.uuid();

  it("returns paginated email logs with template name", async () => {
    const now = new Date("2024-06-01T10:00:00Z");
    const mockLog = {
      id: faker.string.uuid(),
      registrationId,
      subject: "Registration Confirmed",
      status: "SENT",
      trigger: "REGISTRATION_CREATED",
      template: { name: "Welcome Email" },
      errorMessage: null,
      queuedAt: now,
      sentAt: now,
      deliveredAt: null,
      openedAt: null,
      clickedAt: null,
      bouncedAt: null,
      failedAt: null,
    };

    prismaMock.emailLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.emailLog.count.mockResolvedValue(1);

    const result = await listRegistrationEmailLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].subject).toBe("Registration Confirmed");
    expect(result.data[0].status).toBe("SENT");
    expect(result.data[0].templateName).toBe("Welcome Email");
    expect(result.data[0].trigger).toBe("REGISTRATION_CREATED");
    expect(result.meta.total).toBe(1);
  });

  it("returns null templateName when no template linked", async () => {
    const mockLog = {
      id: faker.string.uuid(),
      registrationId,
      subject: "Test Email",
      status: "QUEUED",
      trigger: null,
      template: null,
      errorMessage: null,
      queuedAt: new Date(),
      sentAt: null,
      deliveredAt: null,
      openedAt: null,
      clickedAt: null,
      bouncedAt: null,
      failedAt: null,
    };

    prismaMock.emailLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.emailLog.count.mockResolvedValue(1);

    const result = await listRegistrationEmailLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data[0].templateName).toBeNull();
  });

  it("returns empty page when no email logs exist", async () => {
    prismaMock.emailLog.findMany.mockResolvedValue([]);
    prismaMock.emailLog.count.mockResolvedValue(0);

    const result = await listRegistrationEmailLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
  });

  it("serializes date fields to ISO strings", async () => {
    const queuedAt = new Date("2024-06-01T09:00:00Z");
    const sentAt = new Date("2024-06-01T09:01:00Z");
    const mockLog = {
      id: faker.string.uuid(),
      registrationId,
      subject: "Test",
      status: "SENT",
      trigger: null,
      template: null,
      errorMessage: null,
      queuedAt,
      sentAt,
      deliveredAt: null,
      openedAt: null,
      clickedAt: null,
      bouncedAt: null,
      failedAt: null,
    };

    prismaMock.emailLog.findMany.mockResolvedValue([mockLog] as never);
    prismaMock.emailLog.count.mockResolvedValue(1);

    const result = await listRegistrationEmailLogs(registrationId, {
      page: 1,
      limit: 50,
    });

    expect(result.data[0].queuedAt).toBe(queuedAt.toISOString());
    expect(result.data[0].sentAt).toBe(sentAt.toISOString());
  });
});

// ============================================================================
// searchRegistrantsForSponsorship
// ============================================================================

describe("searchRegistrantsForSponsorship", () => {
  const eventId = faker.string.uuid();

  it("returns matched registrants by email", async () => {
    const mockRegistrant = {
      id: faker.string.uuid(),
      email: "john.doe@example.com",
      firstName: "John",
      lastName: "Doe",
      paymentStatus: "PENDING",
      totalAmount: 300,
      accessTypeIds: [],
    };

    prismaMock.registration.findMany.mockResolvedValue([
      mockRegistrant,
    ] as never);

    const result = await searchRegistrantsForSponsorship(eventId, {
      query: "john",
      unpaidOnly: false,
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("john.doe@example.com");
    expect(result[0].firstName).toBe("John");
    expect(result[0].paymentStatus).toBe("PENDING");
  });

  it("returns empty array when no registrants match", async () => {
    prismaMock.registration.findMany.mockResolvedValue([]);

    const result = await searchRegistrantsForSponsorship(eventId, {
      query: "nobody",
      unpaidOnly: false,
      limit: 10,
    });

    expect(result).toHaveLength(0);
  });

  it("filters to unpaid only when unpaidOnly is true", async () => {
    prismaMock.registration.findMany.mockResolvedValue([]);

    await searchRegistrantsForSponsorship(eventId, {
      query: "test",
      unpaidOnly: true,
      limit: 10,
    });

    expect(prismaMock.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentStatus: { in: ["PENDING", "VERIFYING"] },
        }),
      }),
    );
  });

  it("does not filter by payment status when unpaidOnly is false", async () => {
    prismaMock.registration.findMany.mockResolvedValue([]);

    await searchRegistrantsForSponsorship(eventId, {
      query: "test",
      unpaidOnly: false,
      limit: 10,
    });

    const call = prismaMock.registration.findMany.mock.calls[0]?.[0];
    expect(call?.where?.paymentStatus).toBeUndefined();
  });

  it("respects the limit parameter", async () => {
    prismaMock.registration.findMany.mockResolvedValue([]);

    await searchRegistrantsForSponsorship(eventId, {
      query: "test",
      unpaidOnly: false,
      limit: 5,
    });

    expect(prismaMock.registration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  it("returns registrant with accessTypeIds populated", async () => {
    const accessId = faker.string.uuid();
    const mockRegistrant = {
      id: faker.string.uuid(),
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Smith",
      paymentStatus: "PENDING",
      totalAmount: 400,
      accessTypeIds: [accessId],
    };

    prismaMock.registration.findMany.mockResolvedValue([
      mockRegistrant,
    ] as never);

    const result = await searchRegistrantsForSponsorship(eventId, {
      query: "jane",
      unpaidOnly: false,
      limit: 10,
    });

    expect(result[0].accessTypeIds).toEqual([accessId]);
  });
});

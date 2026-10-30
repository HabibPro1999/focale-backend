import { describe, it, expect, beforeEach } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockEventAccess } from "../../../tests/helpers/factories.js";
import { assertAccessSelectionRequirement } from "./access-validation.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { faker } from "@faker-js/faker";

describe("assertAccessSelectionRequirement", () => {
  const eventId = faker.string.uuid();

  // getGroupedAccess uses `include: { requiredAccess }`, the selected-items
  // lookup uses `select: { id, includedInBase }`. Route each to its own list.
  function mockAccessQueries(options: {
    selected?: Array<{ id: string; includedInBase: boolean }>;
    visible?: ReturnType<typeof createMockEventAccess>[];
  }) {
    prismaMock.eventAccess.findMany.mockImplementation((args: unknown) => {
      const hasInclude =
        typeof args === "object" &&
        args !== null &&
        "include" in (args as Record<string, unknown>);
      if (hasInclude) {
        return Promise.resolve(
          (options.visible ?? []).map((access) => ({
            ...access,
            requiredAccess: [],
          })),
        ) as never;
      }
      return Promise.resolve(options.selected ?? []) as never;
    });
  }

  beforeEach(() => {
    mockAccessQueries({});
  });

  it("does nothing when the setting is off", async () => {
    await expect(
      assertAccessSelectionRequirement(eventId, {}, [], {}),
    ).resolves.toBeUndefined();
    await expect(
      assertAccessSelectionRequirement(eventId, {}, [], undefined),
    ).resolves.toBeUndefined();
    await expect(
      assertAccessSelectionRequirement(eventId, {}, [], {
        accessSelectionRequired: false,
      }),
    ).resolves.toBeUndefined();
    expect(prismaMock.eventAccess.findMany).not.toHaveBeenCalled();
  });

  it("passes when a selected item is not includedInBase", async () => {
    const chosenId = faker.string.uuid();
    mockAccessQueries({
      selected: [{ id: chosenId, includedInBase: false }],
    });

    await expect(
      assertAccessSelectionRequirement(
        eventId,
        {},
        [{ accessId: chosenId, quantity: 1 }],
        { accessSelectionRequired: true },
      ),
    ).resolves.toBeUndefined();
  });

  it("throws ACC_7012 when only included items are selected but something is selectable", async () => {
    const includedId = faker.string.uuid();
    mockAccessQueries({
      selected: [{ id: includedId, includedInBase: true }],
      visible: [
        createMockEventAccess({
          id: includedId,
          eventId,
          includedInBase: true,
          type: "ADDON",
        }),
        createMockEventAccess({
          id: faker.string.uuid(),
          eventId,
          includedInBase: false,
          type: "ADDON",
          maxCapacity: 10,
          paidCount: 0,
        }),
      ],
    });

    await expect(
      assertAccessSelectionRequirement(
        eventId,
        {},
        [{ accessId: includedId, quantity: 1 }],
        { accessSelectionRequired: true },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCodes.ACCESS_SELECTION_REQUIRED,
    });
  });

  it("passes when nothing is selectable (all included or all full)", async () => {
    mockAccessQueries({
      visible: [
        createMockEventAccess({
          eventId,
          includedInBase: true,
          type: "ADDON",
        }),
        createMockEventAccess({
          eventId,
          includedInBase: false,
          type: "ADDON",
          maxCapacity: 5,
          paidCount: 5,
        }),
      ],
    });

    await expect(
      assertAccessSelectionRequirement(eventId, {}, [], {
        accessSelectionRequired: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when nothing is selected at all and an option is available", async () => {
    mockAccessQueries({
      visible: [
        createMockEventAccess({
          eventId,
          includedInBase: false,
          type: "ADDON",
          maxCapacity: null,
        }),
      ],
    });

    await expect(
      assertAccessSelectionRequirement(eventId, {}, [], {
        accessSelectionRequired: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
  });
});

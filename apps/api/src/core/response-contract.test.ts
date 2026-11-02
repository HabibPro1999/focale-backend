import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RESPONSE_CONTRACT,
  ResponseContract,
  assertProjectable,
  projectOntoContract,
  type DroppedKeys,
} from "./response-contract";

const Item = z.object({ id: z.string(), qty: z.number() });
const Contract = z.object({
  id: z.string(),
  when: z.date(),
  note: z.string().nullable(),
  items: z.array(Item),
  meta: z.object({ a: z.number() }).optional(),
  byKey: z.record(z.string(), Item),
  opaque: z.unknown(),
});

describe("projectOntoContract", () => {
  it("drops undeclared keys at every depth and reports their paths, never values", () => {
    const when = new Date("2026-09-01T10:00:00.000Z");
    const { value, stripped } = projectOntoContract(Contract, {
      id: "r1",
      secret: "s3cr3t",
      when,
      note: null,
      items: [
        { id: "a", qty: 1, internal: true },
        { id: "b", qty: 2, internal: false },
      ],
      meta: { a: 1, b: 2 },
      byKey: { x: { id: "x", qty: 3, hidden: 1 } },
      opaque: { anything: { goes: [1, 2] } },
    });
    expect(value).toEqual({
      id: "r1",
      when,
      note: null,
      items: [
        { id: "a", qty: 1 },
        { id: "b", qty: 2 },
      ],
      meta: { a: 1 },
      byKey: { x: { id: "x", qty: 3 } },
      opaque: { anything: { goes: [1, 2] } },
    });
    expect(stripped).toEqual(["secret", "items[].internal", "meta.b", "byKey{}.hidden"]);
    expect(JSON.stringify(stripped)).not.toContain("s3cr3t");
  });

  it("keeps the input's key order, so a matching payload serializes byte for byte", () => {
    const input = {
      opaque: 1,
      byKey: {},
      items: [{ qty: 1, id: "a" }],
      note: "n",
      when: new Date("2026-09-01T10:00:00.000Z"),
      id: "r1",
    };
    const { value, stripped } = projectOntoContract(Contract, input);
    expect(stripped).toEqual([]);
    expect(JSON.stringify(value)).toBe(JSON.stringify(input));
    expect(value).not.toBe(input);
  });

  it("drops an object or array found where the contract declares a scalar", () => {
    const { value, stripped } = projectOntoContract(
      z.object({ name: z.string(), tags: z.array(z.string()) }),
      { name: { first: "Ada", email: "ada@example.com" }, tags: ["x", { leaked: true }] },
    );
    expect(value).toEqual({ tags: ["x", null] });
    expect(stripped).toEqual(["name", "tags[]"]);
  });

  it("drops a non-object where an object is declared only if it carries keys", () => {
    const schema = z.object({ inner: z.object({ a: z.string() }) });
    expect(projectOntoContract(schema, { inner: "text" }).value).toEqual({ inner: "text" });
    expect(projectOntoContract(schema, { inner: ["a"] })).toEqual({
      value: {},
      stripped: ["inner"],
    });
  });

  it("projects a union through the option the value matches, else one of the same kind", () => {
    const schema = z.union([
      z.object({ kind: z.literal("a"), a: z.string() }),
      z.object({ kind: z.literal("b"), b: z.number() }),
    ]);
    expect(projectOntoContract(schema, { kind: "b", b: 1, x: 1 })).toEqual({
      value: { kind: "b", b: 1 },
      stripped: ["x"],
    });
    // Matches no option: still projected (onto the first object option).
    expect(projectOntoContract(schema, { kind: "c", a: "x", y: 1 })).toEqual({
      value: { kind: "c", a: "x" },
      stripped: ["y"],
    });
  });

  it("passes null/undefined through optional and nullable wrappers, and top-level arrays", () => {
    const schema = z.array(z.object({ id: z.string(), meta: Item.nullable().optional() }));
    expect(
      projectOntoContract(schema, [
        { id: "1", meta: null, x: 1 },
        { id: "2" },
        { id: "3", meta: { id: "m", qty: 1, y: 2 } },
      ]),
    ).toEqual({
      value: [{ id: "1", meta: null }, { id: "2" }, { id: "3", meta: { id: "m", qty: 1 } }],
      stripped: ["[].x", "[].meta.y"],
    });
  });

  it("follows lazy schemas", () => {
    type Node = { name: string; children: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(NodeSchema) }),
    );
    expect(
      projectOntoContract(NodeSchema, {
        name: "root",
        extra: 1,
        children: [{ name: "leaf", children: [], extra: 2 }],
      }),
    ).toEqual({
      value: { name: "root", children: [{ name: "leaf", children: [] }] },
      stripped: ["extra", "children[].extra"],
    });
  });
});

describe("assertProjectable / @ResponseContract", () => {
  it("accepts plain data schemas", () => {
    expect(() => assertProjectable(Contract)).not.toThrow();
    expect(() => assertProjectable(z.strictObject({ a: z.string() }))).not.toThrow();
  });

  it.each([
    ["open objects", z.looseObject({ a: z.string() }), "open objects"],
    ["catchall", z.object({ a: z.string() }).catchall(z.string()), "open objects"],
    ["transforms", z.object({ a: z.string().transform((s) => s.length) }), '"pipe"'],
    ["intersections", z.intersection(Item, z.object({ b: z.string() })), '"intersection"'],
    ["tuples", z.object({ t: z.tuple([z.string()]) }), '"tuple"'],
  ])("refuses %s at decoration time, naming where", (_name, schema, message) => {
    expect(() => ResponseContract(schema as z.ZodType)).toThrow(message);
  });

  it("records the schema as handler metadata", () => {
    class Controller {
      @ResponseContract(Item)
      handler() {
        return { id: "x", qty: 1 };
      }
    }
    expect(Reflect.getMetadata(RESPONSE_CONTRACT, Controller.prototype.handler)).toBe(Item);
  });

  it("type-checks the handler's result against the contract", () => {
    class Controller {
      @ResponseContract(Item)
      async fits() {
        return { id: "x", qty: 1 };
      }

      // @ts-expect-error qty is missing
      @ResponseContract(Item)
      missing() {
        return { id: "x" };
      }

      // @ts-expect-error a key the contract would drop
      @ResponseContract(Item)
      extra() {
        return { id: "x", qty: 1, secret: "s" };
      }
    }
    expect(Controller).toBeDefined();
  });
});

describe("DroppedKeys", () => {
  type C = z.input<typeof Contract>;

  it("is never when the static result fits the contract", () => {
    const none: [DroppedKeys<{ id: string; opaque: { any: 1 } }, C>] extends [never]
      ? true
      : false = true;
    expect(none).toBe(true);
  });

  it("names nested, array and record paths", () => {
    const paths: DroppedKeys<
      {
        id: string;
        secret: string;
        items: { id: string; qty: number; internal: boolean }[];
        byKey: Record<string, { id: string; qty: number; hidden: 1 }>;
        meta?: { a: number; b: number } | null;
      },
      C
    >[] = ["secret", "items[].internal", "byKey{}.hidden", "meta.b"];
    expect(paths).toHaveLength(4);
    // @ts-expect-error not a dropped path
    const wrong: DroppedKeys<{ id: string; secret: string }, C> = "id";
    expect(wrong).toBe("id");
  });
});

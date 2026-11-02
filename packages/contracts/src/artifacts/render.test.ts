import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as barrel from "../index";
import { parseParityCases, PARITY_FIXTURES, renderParityFixture } from "./fixtures";
import { collectContractSchemas, renderJsonSchemaDocument, type JsonSchemaDocument } from "./json-schema";
import { renderContractArtifacts, type GeneratedFile } from "./render";

const contractsDir = resolve(__dirname, "..", "..");
const sharedSrcDir = resolve(contractsDir, "..", "shared", "src");

let cached: GeneratedFile[] | undefined;
function artifacts(): GeneratedFile[] {
  cached ??= renderContractArtifacts(sharedSrcDir);
  return cached;
}

function file(path: string): string {
  const found = artifacts().find((item) => item.path === path);
  if (!found) throw new Error(`no generated file ${path}`);
  return found.content;
}

describe("contract artifacts", () => {
  it("match the committed packages/contracts/generated (run `pnpm contracts:generate`)", () => {
    for (const item of artifacts()) {
      expect(readFileSync(join(contractsDir, "generated", item.path), "utf8"), item.path).toBe(item.content);
    }
  });

  it("are deterministic", () => {
    expect(renderContractArtifacts(sharedSrcDir)).toEqual(artifacts());
  });

  it("cover every Zod schema the barrel exports", () => {
    const covered = new Set<unknown>(collectContractSchemas().map((entry) => entry.schema));
    const missing = Object.entries(barrel)
      .filter(([, value]) => value instanceof z.ZodType && !covered.has(value))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("export a schema object exported twice as an alias", () => {
    const input = JSON.parse(file("json-schema/contracts.input.json")) as JsonSchemaDocument;
    expect(input.$defs.ExportLanguageSchema).toEqual({ $ref: "#/$defs/LanguageCodeSchema" });
    expect(file("types/contracts.input.ts")).toContain("export type ExportLanguage = LanguageCode;");
  });

  it("have one TypeScript type per schema in each direction", () => {
    const count = collectContractSchemas().length;
    for (const direction of ["input", "output"]) {
      const defs = Object.keys((JSON.parse(file(`json-schema/contracts.${direction}.json`)) as JsonSchemaDocument).$defs);
      expect(defs).toHaveLength(count);
      expect(file(`types/contracts.${direction}.ts`).match(/^export type /gm)).toHaveLength(count);
    }
  });

  it("list every construct JSON Schema cannot express, at a resolvable pointer", () => {
    const manifest = JSON.parse(file("manifest.json")) as {
      unrepresentable: { direction: "input" | "output"; pointer: string; reason: string }[];
    };
    const docs = {
      input: JSON.parse(file("json-schema/contracts.input.json")) as unknown,
      output: JSON.parse(file("json-schema/contracts.output.json")) as unknown,
    };
    for (const entry of manifest.unrepresentable) {
      let node: unknown = docs[entry.direction];
      for (const token of entry.pointer.slice(1).split("/")) {
        node = (node as Record<string, unknown>)[token.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      expect((node as { $comment?: string } | undefined)?.$comment, entry.pointer).toMatch(`unrepresentable: ${entry.reason}`);
    }
    const reasons = (direction: string) =>
      [...new Set(manifest.unrepresentable.filter((e) => e.direction === direction).map((e) => e.reason))].sort();
    expect(reasons("input")).toEqual(["date", "opaque", "preprocess"]);
    expect(reasons("output")).toEqual(["date", "transform"]);
    expect(
      manifest.unrepresentable.filter((e) => e.reason === "opaque").map((e) => e.pointer),
    ).toEqual([
      "/$defs/NetworkingSpaceUpdateSchema",
      "/$defs/NetworkingTableUpdateSchema",
      "/$defs/UpdateNetworkingConfigSchema",
    ]);
  });

  it("map dates to ISO strings in both directions", () => {
    for (const direction of ["input", "output"] as const) {
      const document = renderJsonSchemaDocument(direction);
      const startDate = (document.$defs.CreateEventSchema.properties as Record<string, { type: string; format: string }>)
        .startDate;
      expect(startDate).toMatchObject({ type: "string", format: "date-time" });
    }
  });

  it("produce TypeScript that compiles strictly and describes the wire shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-types-"));
    try {
      writeFileSync(join(dir, "contracts.input.ts"), file("types/contracts.input.ts"));
      writeFileSync(join(dir, "contracts.output.ts"), file("types/contracts.output.ts"));
      writeFileSync(
        join(dir, "usage.ts"),
        [
          'import type { Condition, TiptapDocument, CreateEvent } from "./contracts.input";',
          'import type * as Out from "./contracts.output";',
          'export const condition: Condition = { fieldId: "f", operator: "in", value: ["a"] };',
          "// @ts-expect-error not an operator",
          'export const bad: Condition = { fieldId: "f", operator: "starts_with" };',
          'export const doc: TiptapDocument = { type: "doc", content: [{ type: "p", content: [{ type: "text", text: "hi" }] }] };',
          'export const slot: Out.TimeSlot = { startsAt: "2026-09-01T08:00:00.000Z", endsAt: null, selectionType: "single", items: [] };',
          "// @ts-expect-error a Date is a string on the wire",
          "export const when: CreateEvent['startDate'] = new Date();",
        ].join("\n"),
      );
      const program = ts.createProgram([join(dir, "usage.ts")], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        isolatedModules: true,
        types: [],
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parity fixtures", () => {
  it("export every source case unchanged, one per line", () => {
    for (const spec of PARITY_FIXTURES) {
      const source = JSON.parse(readFileSync(join(sharedSrcDir, spec.source), "utf8")) as { cases: unknown[] };
      const rendered = renderParityFixture(spec, sharedSrcDir);
      const parsed = JSON.parse(rendered) as { format: string; evaluator: string; cases: unknown[] };
      expect(parsed.format).toBe("focale.condition-parity/v1");
      expect(parsed.evaluator).toBe(spec.id);
      expect(parsed.cases).toEqual(source.cases);
      expect(rendered.split("\n").filter((line) => line.startsWith('    {"name":'))).toHaveLength(source.cases.length);
    }
  });

  it("reject malformed case files", () => {
    const valid = { name: "a", conditions: [], formData: {}, expected: true };
    expect(() => parseParityCases("x.json", { description: "d", cases: [valid, valid] })).toThrow(/duplicate case name/);
    expect(() =>
      parseParityCases("x.json", { description: "d", cases: [{ ...valid, expected: "yes" }] }),
    ).toThrow(/expected must be/);
    expect(() => parseParityCases("x.json", { description: "d", cases: [{ ...valid, note: 1 }] })).toThrow(
      /unknown keys note/,
    );
    expect(() => parseParityCases("x.json", { description: "d", cases: [] })).toThrow(/missing cases/);
  });

  it("put case keys in the documented order", () => {
    const { cases } = parseParityCases("x.json", {
      description: "d",
      cases: [{ expected: false, formData: {}, logic: "or", conditions: [], name: "n" }],
    });
    expect(Object.keys(cases[0])).toEqual(["name", "conditions", "logic", "formData", "expected"]);
  });
});

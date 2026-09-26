// Workspace package boundaries, enforced by `pnpm lint` (plan 6.7).
//
//   contracts ← shared ← db ← integrations ← apps (api, worker)
//
// A package may import only the packages to its left, and the apps never
// import each other. Every import form is checked (static, `export … from`,
// dynamic `import()`, `typeof import()`, `require()`, `import x = require()`),
// and relative specifiers are resolved against the importing file, so
// `../../integrations/src/x` from packages/db is caught even though the string
// never names `packages/`. Files outside the workspace packages (legacy `src/`,
// root configs) are not policed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { explicitWriteExecutor } from "./eslint-write-executor.mjs";

export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `@app/<key>` → its directory and the packages it may import. */
export const WORKSPACE_PACKAGES = {
  contracts: { dir: "packages/contracts", mayImport: [] },
  shared: { dir: "packages/shared", mayImport: ["contracts"] },
  db: { dir: "packages/db", mayImport: ["contracts", "shared"] },
  integrations: { dir: "packages/integrations", mayImport: ["contracts", "shared", "db"] },
  api: { dir: "apps/api", mayImport: ["contracts", "shared", "db", "integrations"] },
  worker: { dir: "apps/worker", mayImport: ["contracts", "shared", "db", "integrations"] },
};

function packageOfPath(absolutePath) {
  const relative = path.relative(WORKSPACE_ROOT, absolutePath).split(path.sep).join("/");
  for (const [key, { dir }] of Object.entries(WORKSPACE_PACKAGES)) {
    if (relative === dir || relative.startsWith(`${dir}/`)) return key;
  }
  return null;
}

function packageOfSpecifier(specifier, fromFile) {
  const named = /^@app\/([^/]+)/.exec(specifier);
  if (named) return Object.hasOwn(WORKSPACE_PACKAGES, named[1]) ? named[1] : null;
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    return packageOfPath(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const packageBoundaries = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce the workspace layers: contracts ← shared ← db ← integrations ← apps; apps never import each other.",
    },
    schema: [],
    messages: {
      forbidden:
        "{{from}} must not import {{to}} ('{{specifier}}'). Workspace layers: contracts ← shared ← db ← integrations ← apps, and apps never import each other.",
    },
  },
  create(context) {
    const filename = context.filename;
    const from = packageOfPath(filename);
    if (!from) return {};
    const allowed = new Set(WORKSPACE_PACKAGES[from].mayImport);

    function check(sourceNode) {
      const specifier = staticString(sourceNode);
      if (specifier === null) return;
      const to = packageOfSpecifier(specifier, filename);
      if (!to || to === from || allowed.has(to)) return;
      context.report({
        node: sourceNode,
        messageId: "forbidden",
        data: { from: WORKSPACE_PACKAGES[from].dir, to: `@app/${to}`, specifier },
      });
    }

    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
      // `typeof import("x")`: `argument` holds a TSLiteralType in typescript-eslint 8.
      TSImportType: node => check(node.source ?? node.argument?.literal ?? node.argument),
      TSImportEqualsDeclaration: node => {
        if (node.moduleReference.type === "TSExternalModuleReference") check(node.moduleReference.expression);
      },
      CallExpression: node => {
        if (node.callee.type === "Identifier" && node.callee.name === "require") check(node.arguments[0]);
      },
    };
  },
};

/** ESLint plugin registered as `focale` in eslint.config.mjs. */
export const focalePlugin = {
  meta: { name: "focale-workspace" },
  rules: {
    "package-boundaries": packageBoundaries,
    "explicit-write-executor": explicitWriteExecutor,
  },
};

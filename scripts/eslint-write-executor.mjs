// Writes take their executor explicitly (plan 5.1), enforced by `pnpm lint`
// on packages/db/src.
//
// A write function whose executor parameter has a default (`exec = getDb()`)
// or is optional lets a caller inside a transaction forget `tx`: the write
// then commits on its own, outside the transaction, and nothing fails. So a
// function that writes must not default or omit its executor; reads may.
//
// "Writes" is decided by what the function does, with type information: it
// calls insert/update/delete on a database executor, runs SQL containing
// INSERT/UPSERT/UPDATE/DELETE, or calls (in any file of the program) a
// function that does. Nested closures count. Row locks alone (FOR UPDATE)
// do not.

import { createRequire } from "node:module";

// typescript is typescript-eslint's peer dependency; the workspace root does
// not depend on it directly, so resolve it from there.
const ts = createRequire(import.meta.resolve("typescript-eslint"))("typescript");

/** A type is a database executor when it has the Drizzle db/transaction query methods. */
const EXECUTOR_MEMBERS = ["select", "insert", "update", "delete", "execute"];
const WRITE_METHODS = new Set(["insert", "update", "delete"]);
// UPDATE after FOR/ON/DO/KEY is a row lock, a foreign-key action or an upsert
// branch; `UPDATE SET` is part of ON CONFLICT DO UPDATE.
const WRITE_SQL = /\bINSERT\s+INTO\b|\bUPSERT\s+INTO\b|\bDELETE\s+FROM\b|(?<!\b(?:FOR|ON|DO|KEY)\s+)\bUPDATE\s+(?!SET\b)["\w$]/i;

function isExecutorType(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => EXECUTOR_MEMBERS.every((member) => part.getProperty(member)));
}

function functionLabel(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) {
    return parent.name.getText();
  }
  return "an inner function";
}

const analyzers = new WeakMap();

/** Write analysis over one TypeScript program, cached across the files it lints. */
function analyzerFor(program) {
  let analyzer = analyzers.get(program);
  if (analyzer) return analyzer;
  const checker = program.getTypeChecker();
  const memo = new Map();

  function calleeFunction(expression) {
    const target = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    let symbol = checker.getSymbolAtLocation(target);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.declarations ?? []) {
      if (declaration.getSourceFile().isDeclarationFile) continue;
      if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) {
        return declaration;
      }
      const initializer = declaration.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer;
    }
    return null;
  }

  /** Why `fn` writes ("INSERT", "raw SQL write", "calls x"), or null for a read. */
  function writeOf(fn, stack = new Set()) {
    if (memo.has(fn)) return memo.get(fn);
    if (stack.has(fn)) return null;
    stack.add(fn);
    let reason = null;
    const visit = (node) => {
      if (reason) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          WRITE_METHODS.has(callee.name.text) &&
          isExecutorType(checker.getTypeAtLocation(callee.expression))
        ) {
          reason = callee.name.text.toUpperCase();
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "raw" &&
          node.arguments.length > 0 &&
          WRITE_SQL.test(node.arguments[0].getText())
        ) {
          reason = "raw SQL write";
        } else {
          const target = calleeFunction(callee);
          if (target && target !== fn && writeOf(target, stack)) reason = `calls ${functionLabel(target)}`;
        }
      } else if (ts.isTaggedTemplateExpression(node) && WRITE_SQL.test(node.template.getText())) {
        reason = "raw SQL write";
      }
      if (!reason) ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    stack.delete(fn);
    // A read found while a caller was still on the stack may depend on that
    // caller (recursion), so only settled answers are cached.
    if (reason || stack.size === 0) memo.set(fn, reason);
    return reason;
  }

  analyzer = { checker, writeOf };
  analyzers.set(program, analyzer);
  return analyzer;
}

export const explicitWriteExecutor = {
  meta: {
    type: "problem",
    docs: {
      description: "Write functions take their database executor explicitly: no default or optional executor parameter.",
    },
    schema: [],
    messages: {
      defaulted:
        "'{{name}}' writes ({{reason}}), so its executor '{{param}}' must be explicit: drop the {{kind}} and pass `tx` inside a transaction or `getDb()` outside one (plan 5.1).",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error("focale/explicit-write-executor needs type information (parserOptions.projectService).");
    }
    const { checker, writeOf } = analyzerFor(services.program);

    function check(node) {
      const fn = services.esTreeNodeToTSNodeMap.get(node);
      if (!fn?.parameters) return;
      for (const param of fn.parameters) {
        const kind = param.initializer ? "default" : param.questionToken ? "optional marker" : null;
        if (!kind) continue;
        if (!isExecutorType(checker.getNonNullableType(checker.getTypeAtLocation(param)))) continue;
        const reason = writeOf(fn);
        if (!reason) return;
        context.report({
          node: services.tsNodeToESTreeNodeMap.get(param) ?? node,
          messageId: "defaulted",
          data: { name: functionLabel(fn), reason, param: param.name.getText(), kind },
        });
      }
    }

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
};

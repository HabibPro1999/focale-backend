"use strict";

// Runs TypeScript source for `pnpm dev`, `pnpm dev:worker` and the ops scripts:
//   node --conditions=@app/source -r ../../scripts/swc-register.cjs src/main.ts
//
// Each .ts file is compiled on require with SWC: CommonJS output, legacy
// decorators and decorator metadata (Nest resolves constructor injection from
// `design:paramtypes`). It never loads the `typescript` package, so it works
// with TypeScript 7, which has no JS API; that is why it replaces
// @swc-node/register. Keep the SWC options in line with swcDecoratorOptions()
// in packages/vitest.shared.ts.

const { addHook } = require("pirates");
const { transformSync } = require("@swc/core");

process.setSourceMapsEnabled(true);

addHook(
  (code, filename) =>
    transformSync(code, {
      filename,
      swcrc: false,
      configFile: false,
      sourceMaps: "inline",
      // ignoreDynamic keeps import() native, as tsc does for CommonJS output.
      module: { type: "commonjs", ignoreDynamic: true },
      jsc: {
        target: "es2022",
        keepClassNames: true,
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }).code,
  { exts: [".ts", ".cts"] },
);

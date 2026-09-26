import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { focalePlugin } from "./scripts/eslint-package-boundaries.mjs";

// The recommended sets stay advisory (warnings); the rules below are errors
// and fail `pnpm lint` in CI (plan 6.7).
function downgradeRules(config) {
  if (!config.rules) return config;

  return {
    ...config,
    rules: Object.fromEntries(
      Object.entries(config.rules).map(([name, setting]) => {
        const severity = Array.isArray(setting) ? setting[0] : setting;
        if (severity === "off" || severity === 0) return [name, setting];
        return [name, Array.isArray(setting) ? ["warn", ...setting.slice(1)] : "warn"];
      }),
    ),
  };
}

// Files whose write functions still default their executor, converted in
// plan 5.1b (networking queries were being rewritten when 5.1a landed).
// Remove entries as they are converted; don't add new ones.
export const WRITE_EXECUTOR_ALLOW_LIST = ["packages/db/src/queries/networking*.ts"];

const sourceFiles = [
  "apps/*/src/**/*.{ts,tsx,mts,cts}",
  "packages/*/src/**/*.{ts,tsx,mts,cts}",
];

export default tseslint.config(
  downgradeRules(eslint.configs.recommended),
  ...tseslint.configs.recommended.map(downgradeRules),
  {
    plugins: { focale: focalePlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        // ignoreRestSiblings: `const { secret, ...safe } = row` is how public
        // projections strip fields; tsc's noUnusedLocals exempts it too.
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // contracts ← shared ← db ← integrations ← apps; apps never import each other.
      "focale/package-boundaries": "error",
    },
  },
  {
    // Type-aware rules need a tsconfig, which covers each package's src only.
    files: sourceFiles,
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // Write functions take their executor explicitly (plan 5.1).
    files: ["packages/db/src/**/*.ts"],
    ignores: WRITE_EXECUTOR_ALLOW_LIST,
    rules: {
      "focale/explicit-write-executor": "error",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "prisma/**",
    ],
  },
);

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Module boundary enforcement
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/modules/identity/**",
                "!**/modules/identity/index.js",
              ],
              message: "Import from @identity barrel, not internal files",
            },
            {
              group: ["**/modules/clients/**", "!**/modules/clients/index.js"],
              message: "Import from @clients barrel, not internal files",
            },
            {
              group: ["**/modules/events/**", "!**/modules/events/index.js"],
              message: "Import from @events barrel, not internal files",
            },
            {
              group: ["**/modules/forms/**", "!**/modules/forms/index.js"],
              message: "Import from @forms barrel, not internal files",
            },
            {
              group: ["**/modules/access/**", "!**/modules/access/index.js"],
              message: "Import from @access barrel, not internal files",
            },
            {
              group: [
                "**/modules/registrations/**",
                "!**/modules/registrations/index.js",
              ],
              message: "Import from @registrations barrel, not internal files",
            },
            {
              group: ["**/modules/reports/**", "!**/modules/reports/index.js"],
              message: "Import from @reports barrel, not internal files",
            },
            {
              group: ["**/modules/email/**", "!**/modules/email/index.js"],
              message: "Import from @email barrel, not internal files",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "prisma/**",
      "scripts/**",
      "tests/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
);

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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

const sourceFiles = [
  "apps/*/src/**/*.{ts,tsx,mts,cts}",
  "packages/*/src/**/*.{ts,tsx,mts,cts}",
];

export default tseslint.config(
  downgradeRules(eslint.configs.recommended),
  ...tseslint.configs.recommended.map(downgradeRules),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Module boundary checks remain visible as the workspace is adopted.
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["**/modules/identity/**", "!**/modules/identity/index.js"],
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
    files: sourceFiles,
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
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
